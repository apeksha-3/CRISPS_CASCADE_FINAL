// engine/tick.ts
// The tick runner: one simulated minute of the engine pipeline.
//
//   1-2  adapt each raw event (unknown schema -> counted and skipped)
//   3    validate (malformed -> quarantined, kept for the dashboard)
//   4    append to the log (dedupe by id, retractions incl. orphans)
//   ---- inside try/catch ----
//   5    cleaned, ordered window + source statuses (live / stale / dark)
//   6    near-duplicate clustering (engine/cluster.ts); retracted members leave their cluster
//   7    common-cause grouping (engine/grouping.ts): lying gateways, rumor narratives
//        -> evidence units
//   8    stages of the causal chain seen; last tick's forecast confirmed / missed
//   9    forward filter on the units that changed: prior -> posterior
//   13   forecast the next 3 stages; one-step lookahead input
//   10   decide: posterior + lookahead + hysteresis state -> action + expected cost
//   14   explanation (template sentences)
//   11   within-episode trust: sources whose new events agree with the leading
//        hypothesis gain a little trust (engine/trust.ts); every scored event is
//        remembered for the between-episode update
//   ---- on ANY error: count-threshold baseline, fallback = true (R11) ----
//   Step 12 (learning trust, base rates and drift once the truth is revealed) runs
//   BETWEEN episodes in engine/learn.ts, never inside a tick.
//   The new state (clusters, scores, forecast, trust) is committed only if every step succeeded.
//
// The engine only ever sees what it is given: the PUBLIC registry, the events
// handed to tick(), and the learned state (trust + prior) at the start of the
// episode. It never reads ground truth.

import { type LikelihoodTables, type LLRow, TUNED_TABLES } from "../config/likelihoods";
import { PRIOR } from "../config/priors";
import { transitionsFor } from "../config/transitions";
import { adaptEvent } from "./adapter";
import { ClusterBook } from "./cluster";
import { decide as defaultDecide, type DecisionConfig, type DecisionState, expectedCosts, initialDecisionState } from "./decide";
import { explain, type UnitChange } from "./explain";
import { fallbackDecision } from "./fallback";
import { forwardFilter as defaultFilter, DEFAULT_FILTER_CONFIG, type FilterConfig, type UnitUpdate, zeroRow } from "./filter";
import { checkForecasts, type ForecastState, forecastLines, initialForecastState, isBenign, lookahead, updateStages, visibleForecast } from "./forecast";
import { applyWeatherCommonCause, detectGatewayGroups, type GatewayFlag, gatewaySensorCounts, isCorroborated, toUnit, type TrustLookup } from "./grouping";
import { EventLog } from "./log";
import { buildCleanedWindow, isStrong, offsetEstimates } from "./order";
import { SourceTracker, summarize, weightedCoverage } from "./source-status";
import { bump, claimOf, type SourceEvidence, trustOf, type TrustState, withRegistry } from "./trust";
import {
  type Action,
  type Event,
  type EvidenceUnit,
  type Explanation,
  type ForecastItem,
  HYPOTHESES,
  type ProbabilityVector,
  type PublicRegistry,
  type QuarantinedEvent,
  type Seconds,
  type SourceStatus,
  type TickRecord,
} from "./types";
import { validateEvent } from "./validate";

export interface EngineOptions {
  filter?: typeof defaultFilter; // swap in for tests (e.g. one that throws)
  decide?: typeof defaultDecide;
  filterConfig?: FilterConfig; // overrides prior / trust weights / tables below
  decisionConfig?: DecisionConfig;
  // Learned between episodes (engine/learn.ts). Defaults: config base rates, type-prior trust.
  prior?: ProbabilityVector;
  trust?: TrustState;
  tables?: LikelihoodTables; // default: the dev-tuned config/likelihoods.ts
}

// Coverage weights: every source counts with the mean trust of its TYPE.
function typeWeights(registry: PublicRegistry, trust: TrustState): Record<string, number> {
  const byType = new Map<string, number[]>();
  for (const s of registry.sources) byType.set(s.source_type, [...(byType.get(s.source_type) ?? []), trust[s.source_id].mean]);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return Object.fromEntries(registry.sources.map((s) => [s.source_id, mean(byType.get(s.source_type)!)]));
}

const NOT_EVIDENCE = new Set(["heartbeat", "retraction"]);
const sameRow = (a: LLRow, b: LLRow) => HYPOTHESES.every((h) => Math.abs(a[h] - b[h]) < 1e-12);

export class Engine {
  readonly log = new EventLog();
  readonly errors: string[] = []; // every caught exception, "t=600: message"
  unparsedTotal = 0;
  private tracker: SourceTracker;
  private offsets: Map<string, Seconds>;
  private zones: Set<string>;
  private registry: PublicRegistry;
  private sensorCounts: Map<string, number>;
  private prior: ProbabilityVector; // raw posterior of the last good tick (starts at the episode's base rates)
  private trust: TrustState; // per-source trust, bumped within the episode
  private evidence: SourceEvidence[] = []; // every scored strong event, for learning after the episode
  private tables: LikelihoodTables;
  private decision: DecisionState = initialDecisionState();
  // ---- Phase 3 state, replaced as a whole at the end of a successful tick ----
  private book = new ClusterBook(); // every event that was scored, by unit
  private scored = new Map<string, LLRow>(); // unit id -> what it currently adds to the belief
  private processed = new Set<string>(); // event ids already put into a unit
  private retractedSeen = new Set<string>(); // processed events whose retraction was applied
  private gatewayFlags: GatewayFlag[] = [];
  private gatewayIds = new Set<string>(); // event ids judged to be a lying gateway's readings
  private forecastState: ForecastState = initialForecastState();
  private last?: { probabilities: ProbabilityVector; action: Action; dark: number };
  private filter: typeof defaultFilter;
  private decideFn: typeof defaultDecide;
  private filterConfig: FilterConfig;
  private decisionConfig: DecisionConfig | undefined;

  constructor(registry: PublicRegistry, opts: EngineOptions = {}) {
    this.registry = registry;
    this.tracker = new SourceTracker(registry);
    this.offsets = offsetEstimates(registry);
    this.zones = new Set(registry.zones.map((z) => z.zone_id));
    this.sensorCounts = gatewaySensorCounts(registry);
    this.filter = opts.filter ?? defaultFilter;
    this.decideFn = opts.decide ?? defaultDecide;
    const base = opts.prior ?? PRIOR;
    this.prior = { ...base };
    this.trust = withRegistry(opts.trust ?? {}, registry);
    this.tables = opts.tables ?? TUNED_TABLES;
    this.filterConfig = opts.filterConfig ?? {
      ...DEFAULT_FILTER_CONFIG,
      basePrior: base,
      transitions: transitionsFor(base),
      tables: this.tables,
      coverageWeights: typeWeights(registry, this.trust),
    };
    this.decisionConfig = opts.decisionConfig;
    if (opts.decisionConfig) this.decision = initialDecisionState(opts.decisionConfig.knobs);
  }

  tick(rawEvents: unknown[], now: Seconds): TickRecord {
    // 1-4: adapt, validate, append. These are pure and per event: one bad event cannot stop the others.
    let unparsed = 0;
    const quarantined: QuarantinedEvent[] = [];
    for (const raw of rawEvents) {
      const e = adaptEvent(raw);
      if (e === null) {
        unparsed++;
        continue;
      }
      const v = validateEvent(e, { now, zones: this.zones });
      if ("quarantined" in v) {
        quarantined.push({ event: v.quarantined, reason: v.reason });
        continue;
      }
      if (this.log.append(v.valid, now) === "added") this.tracker.observe(v.valid);
    }
    this.log.applyPendingRetractions();
    this.unparsedTotal += unparsed;

    try {
      // work on copies; commit at the end only if nothing throws
      const book = this.book.clone();
      const scored = new Map(this.scored);
      const processed = new Set(this.processed);
      const retractedSeen = new Set(this.retractedSeen);
      const gatewayIds = new Set(this.gatewayIds);
      const gatewayFlags = this.gatewayFlags.filter((f) => now - f.at <= 3600);
      const fstate: ForecastState = structuredClone(this.forecastState);
      const trust: TrustState = { ...this.trust };
      const trustLookup: TrustLookup = (e) => trustOf(trust, e.source_id, e.source_type).mean;
      const newIds: string[] = []; // events put into a unit for the first time this tick
      const windowS = this.filterConfig.knobs.window_s;
      const touched = new Set<string>(); // cluster ids changed this tick
      const retractedNow = new Map<string, string[]>(); // cluster id -> event ids retracted this tick

      // 5. who is still talking to us
      const statuses = this.tracker.statuses(now);
      const summary = summarize(statuses);
      const coverage = this.filterConfig.coverageWeights ? weightedCoverage(statuses, this.filterConfig.coverageWeights) : summary.coverage;

      // 6a. retractions of events already scored: the cluster shrinks (n -> n-1)
      for (const id of [...processed].sort()) {
        if (retractedSeen.has(id) || !this.log.isRetracted(id)) continue;
        retractedSeen.add(id);
        const c = book.retract(id);
        if (!c) continue;
        touched.add(c.id);
        retractedNow.set(c.id, [...(retractedNow.get(c.id) ?? []), id]);
      }

      // 7a. lying gateways, found on the raw fresh events BEFORE causal context is built
      const fresh = this.log.activeEvents(now - windowS, now).filter((e) => !NOT_EVIDENCE.has(e.kind) && !processed.has(e.id));
      const groups = detectGatewayGroups(fresh, this.sensorCounts, gatewayFlags, now);
      for (const g of groups) for (const id of g.ids) gatewayIds.add(id);

      // 5b. the cleaned window (lying readings never make anything "chained")
      const window = buildCleanedWindow(this.log, this.offsets, now, windowS, processed, gatewayIds);
      const byId = new Map(window.map((e) => [e.id, e]));

      // 7b. gateway groups become one unit each
      for (const g of groups) {
        const evs = g.ids.map((id) => byId.get(id)).filter((e) => e !== undefined);
        if (evs.length === 0) continue;
        const c = book.addGatewayGroup(g.gateway_id, g.value, evs, g.joinId);
        if (!g.joinId) gatewayFlags.push({ gateway_id: g.gateway_id, value: g.value, unit_id: c.id, at: now });
        touched.add(c.id);
        for (const e of evs) {
          processed.add(e.id);
          newIds.push(e.id);
        }
      }
      // 6b. everything else: near-duplicate or narrative clusters (a lone event is a cluster of 1)
      for (const e of window) {
        if (!e.fresh || processed.has(e.id)) continue;
        touched.add(book.add(e).id);
        processed.add(e.id);
        newIds.push(e.id);
      }
      // 7c. rumor check: does a physical sensor back each live narrative? (sticky once yes)
      const alive = book.all().filter((c) => touched.has(c.id) || (c.members.length > 0 && Math.max(...c.members.map((m) => m.arrived_at)) > now - windowS));
      for (const c of alive) {
        if (c.type === "narrative" && !c.corroborated && isCorroborated(c, window, gatewayIds)) {
          c.corroborated = true;
          touched.add(c.id);
        }
      }
      const units = alive.map((c) => toUnit(c, undefined, trustLookup));

      // 8. causal chain: stages seen (on the undiscounted units), last tick's forecast confirmed or missed
      const freshKinds = updateStages(fstate, units, now);
      const outcomes = checkForecasts(fstate, freshKinds, now, coverage);

      // 7d. rain + drainage + traffic of one zone = one weather event (changes weights for the filter only)
      applyWeatherCommonCause(units);
      const updates: UnitUpdate[] = units.map((u) => ({ unit: u, previous: scored.get(u.unit_id) ?? zeroRow() }));

      // 9. belief
      const fr = this.filter(this.prior, updates, statuses, this.filterConfig, outcomes.map((o) => o.ll));

      // 13. forecast + lookahead
      const lines = forecastLines(fstate, fr.posterior);
      fstate.lines = lines;
      const forecast: ForecastItem[] = visibleForecast(lines, fstate, now);
      const la = lookahead(lines, fstate, fr.posterior, now, fr.coverage, undefined, undefined, this.tables);

      // 10. action
      const d = this.decideFn(fr.posterior, this.decision, this.decisionConfig, la);

      // 14. explanation
      const changes: UnitChange[] = [];
      for (const u of units) {
        const before = scored.get(u.unit_id) ?? zeroRow();
        const after = fr.contributions.get(u.unit_id) ?? before;
        if (sameRow(before, after) && !retractedNow.has(u.unit_id)) continue;
        const delta = zeroRow();
        for (const h of HYPOTHESES) delta[h] = after[h] - before[h];
        changes.push({ unit: u, delta, retracted: retractedNow.get(u.unit_id) ?? [] });
      }
      const lost = fresh
        .filter((e) => e.kind === "gateway_heartbeat_lost")
        .map((e) => e.gateway_id ?? e.source_id)
        .filter((g, i, a) => a.indexOf(g) === i)
        .map((g) => ({ gateway_id: g, sensors: this.sensorCounts.get(g) ?? 0 }));
      const liveUnits = units.filter((u) => u.n > 0 && u.last_arrived_at > now - windowS);
      const explanation: Explanation = explain({
        now,
        prev: this.last,
        probabilities: fr.posterior,
        action: d.action,
        alive: liveUnits,
        changes,
        outcomes,
        gatewaysLost: lost,
        dark: summary.dark,
        coverage: fr.coverage,
        forecast,
        benign: isBenign(fr.posterior),
        chainSeen: Object.keys(fstate.seen).length,
        lookahead: d.lookahead,
        lookaheadKind: la?.kind,
      });

      // 11. trust within the episode: a new strong event whose claim matches the leading
      //     hypothesis earns its source +0.1 alpha. Every new strong event is remembered
      //     (with what it claimed) for the between-episode update in engine/learn.ts.
      const leading = HYPOTHESES.reduce((a, b) => (fr.posterior[b] > fr.posterior[a] ? b : a));
      const evidence: SourceEvidence[] = [];
      for (const id of newIds) {
        const e = byId.get(id);
        const table = e && isStrong(e) ? this.tables.kinds[e.kind] : undefined;
        if (!e || !table) continue;
        const row = e.chained && table.chained ? table.chained : table.alone;
        evidence.push({ event_id: e.id, source_id: e.source_id, source_type: e.source_type, row });
        if (claimOf(row) === leading) trust[e.source_id] = bump(trustOf(trust, e.source_id, e.source_type));
      }

      // commit the new state only after every step succeeded
      for (const [id, ll] of fr.contributions) scored.set(id, ll);
      for (const u of units) {
        if (u.n > 0) continue;
        book.drop(u.unit_id); // every member retracted: its contribution was just subtracted
        scored.delete(u.unit_id);
      }
      this.book = book;
      this.scored = scored;
      this.processed = processed;
      this.retractedSeen = retractedSeen;
      this.gatewayFlags = gatewayFlags;
      this.gatewayIds = gatewayIds;
      this.forecastState = fstate;
      this.trust = trust;
      this.evidence.push(...evidence);
      this.prior = fr.raw;
      this.decision = d.state;
      this.last = { probabilities: fr.posterior, action: d.action, dark: summary.dark };
      return this.record(now, {
        probabilities: fr.posterior,
        action: d.action,
        expected_cost: d.expected_cost,
        expected_costs: d.expected_costs,
        degraded: fr.degraded,
        fallback: false,
        statuses,
        quarantined,
        unparsed,
        forecast,
        explanation,
        evidence_units: liveUnits.length,
        clusters: liveUnits.filter((u) => u.n >= 2).length,
      });
    } catch (err) {
      return this.fallbackTick(now, err, quarantined, unparsed);
    }
  }

  // The causal-chain state: stages seen, forecasts confirmed / missed (for traces and eval).
  chain(): ForecastState {
    return structuredClone(this.forecastState);
  }

  // Evidence units currently held (for traces and tests).
  units(): EvidenceUnit[] {
    const t = this.trust;
    return this.book.all().map((c) => ({ ...toUnit(c, undefined, (e) => trustOf(t, e.source_id, e.source_type).mean), hypothesis_contributions: this.scored.get(c.id) ?? zeroRow() }));
  }

  // Every scored strong event so far, with what it claimed. engine/learn.ts judges
  // them against the revealed truth AFTER the episode.
  sourceEvidence(): SourceEvidence[] {
    return this.evidence.slice();
  }

  // Current per-source trust (including this episode's small in-episode bumps).
  trustState(): TrustState {
    return { ...this.trust };
  }

  // R11: never crash mid-episode. Baseline probabilities, action capped at the previous one.
  private fallbackTick(now: Seconds, err: unknown, quarantined: QuarantinedEvent[], unparsed: number): TickRecord {
    this.errors.push(`t=${now}: ${err instanceof Error ? err.message : String(err)}`);
    const previous = this.decision.current;
    const fb = fallbackDecision(this.log.all(), now, previous);
    if (fb.action !== previous) this.decision = { ...initialDecisionState(), current: fb.action, ticks_at_current: 1 };
    else this.decision = { ...this.decision, ticks_at_current: this.decision.ticks_at_current + 1 };
    let statuses: Record<string, SourceStatus> = {};
    try {
      statuses = this.tracker.statuses(now);
    } catch {
      // statuses are informational here; leave them empty
    }
    const ec = expectedCosts(fb.probabilities);
    this.last = { probabilities: fb.probabilities, action: fb.action, dark: this.last?.dark ?? 0 };
    return this.record(now, {
      probabilities: fb.probabilities,
      action: fb.action,
      expected_cost: ec[fb.action],
      expected_costs: ec,
      degraded: true,
      fallback: true,
      statuses,
      quarantined,
      unparsed,
      forecast: [],
      explanation: {
        top_evidence: [],
        delta_summary: `FALLBACK: the engine failed this tick, using the count-threshold baseline and holding at most ${fb.action}.`,
        forecast_summary: "No forecast while in fallback.",
      },
      evidence_units: 0,
      clusters: 0,
    });
  }

  private record(
    now: Seconds,
    x: Pick<
      TickRecord,
      "probabilities" | "action" | "expected_cost" | "expected_costs" | "degraded" | "fallback" | "quarantined" | "unparsed" | "forecast" | "explanation" | "evidence_units" | "clusters"
    > & {
      statuses: Record<string, SourceStatus>;
    },
  ): TickRecord {
    return {
      tick_time: now,
      probabilities: x.probabilities,
      action: x.action,
      expected_cost: x.expected_cost,
      expected_costs: x.expected_costs,
      forecast: x.forecast,
      explanation: x.explanation,
      evidence_units: x.evidence_units,
      clusters: x.clusters,
      degraded: x.degraded,
      fallback: x.fallback,
      source_statuses: x.statuses,
      source_summary: summarize(x.statuses),
      trust: this.registry.sources.map((s) => this.trust[s.source_id]),
      retroactive_revisions: [],
      quarantined: x.quarantined,
      unparsed: x.unparsed,
    };
  }
}

// Convenience for tests and eval: feed events whose arrived_at falls in (prev, now].
export function newArrivals(events: Event[], from: Seconds, to: Seconds): Event[] {
  return events.filter((e) => e.arrived_at > from && e.arrived_at <= to);
}
