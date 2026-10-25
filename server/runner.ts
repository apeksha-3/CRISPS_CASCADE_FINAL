// server/runner.ts
// Runs the REAL engine (engine/tick.ts, the same class `npm run eval` uses) over one
// episode, one tick at a time, and adds what the dashboard needs to draw the tick:
// the raw events that arrived this minute, the evidence units they were grouped into,
// and whether each forecast was confirmed or missed.
//
// Every replay is a COLD START: the engine begins from the configured base rates
// (config/priors.ts) and the type-prior trust, exactly like episode 1 of an eval run.
// (`npm run eval` carries learned trust from episode to episode, so its per-episode
// numbers can differ slightly from a single replay. The eval TABLE comes from the
// eval code itself, see server/eval-cache.ts.)
//
// Ground truth never reaches the engine here: the engine gets the public registry and
// the events, nothing else. The server reads the truth only to reveal it at the end.

import { FILTER_KNOBS } from "../config/knobs";
import { TUNED_TABLES } from "../config/likelihoods";
import { PRIOR } from "../config/priors";
import { transitionsFor } from "../config/transitions";
import { cascadeLLR, supports } from "../engine/explain";
import { DEFAULT_FILTER_CONFIG } from "../engine/filter";
import { weightedCoverage } from "../engine/source-status";
import { Engine, type EngineOptions } from "../engine/tick";
import { type TrustState, withRegistry } from "../engine/trust";
import type { Event, EventKind, Hypothesis, PublicRegistry, Seconds, TickRecord } from "../engine/types";
import type { Episode } from "../sim/truth";

// One event as the feed shows it. Heartbeats are left out (about 1,000 per episode).
export interface FeedEvent {
  id: string;
  arrived_at: Seconds;
  occurred_at: Seconds;
  source_id: string;
  source_type: string;
  zone_id: string;
  kind: EventKind;
  severity?: number;
  value?: number;
  text?: string;
  retracts?: string; // a retraction: the feed strikes through this earlier event
  dup: boolean; // the same id arrived before (a retransmission; the engine keeps one copy)
  quarantined: boolean; // failed validation this tick, never used as evidence
}

// One evidence unit, short form: lets the dashboard link a clicked event to its unit.
export interface UnitSummary {
  unit_id: string;
  unit_type: string;
  kind: EventKind;
  zone_id: string;
  n: number;
  weight: number;
  llr: number; // CASCADE vs the rest, same number the "why it changed" panel shows
  supports: Hypothesis;
  members: string[]; // event ids
}

export interface TickPayload {
  minute: number;
  record: TickRecord;
  events: FeedEvent[];
  heartbeats: number; // heartbeats that arrived this minute (not shown in the feed)
  units: UnitSummary[];
  forecast_status: Partial<Record<EventKind, "confirmed" | "missed" | "off_window">>;
  coverage_weighted: number; // the trust-weighted coverage DEGRADED is judged on
  degraded_threshold: number;
}

// Demo-only override: a different DEGRADED threshold. The engine code is unchanged;
// the threshold is a knob inside FilterConfig, which the Engine accepts as an option.
export interface RunOptions {
  degradedBelow?: number;
}

// The same coverage weights engine/tick.ts builds: every source counts with the mean
// trust of its TYPE. (Copied, 6 lines, because tick.ts does not export it.)
export function typeWeights(registry: PublicRegistry, trust: TrustState): Record<string, number> {
  const byType = new Map<string, number[]>();
  for (const s of registry.sources) byType.set(s.source_type, [...(byType.get(s.source_type) ?? []), trust[s.source_id].mean]);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return Object.fromEntries(registry.sources.map((s) => [s.source_id, mean(byType.get(s.source_type)!)]));
}

// Cold-start engine options. With no override this is exactly `new Engine(registry, { prior, trust: {} })`.
export function engineOptions(registry: PublicRegistry, opts: RunOptions = {}): EngineOptions {
  const prior = { ...PRIOR };
  if (opts.degradedBelow === undefined) return { prior, trust: {} };
  const trust = withRegistry({}, registry);
  return {
    prior,
    trust,
    filterConfig: {
      ...DEFAULT_FILTER_CONFIG,
      basePrior: prior,
      transitions: transitionsFor(prior),
      tables: TUNED_TABLES,
      coverageWeights: typeWeights(registry, trust),
      knobs: { ...FILTER_KNOBS, degraded_below_coverage: opts.degradedBelow },
    },
  };
}

// A step-by-step runner: call next() once per simulated minute.
export class EpisodeRunner {
  readonly ep: Episode;
  readonly engine: Engine;
  readonly ticks: number;
  private readonly byArrival: Event[];
  private readonly threshold: number;
  private readonly weights: Record<string, number>;
  private cut = 0;
  private t = 0;
  private seenIds = new Set<string>();

  constructor(ep: Episode, opts: RunOptions = {}) {
    this.ep = ep;
    this.engine = new Engine(ep.registry, engineOptions(ep.registry, opts));
    this.byArrival = ep.events.slice().sort((a, b) => a.arrived_at - b.arrived_at); // same order as eval/run.ts
    this.ticks = Math.floor(ep.duration / 60);
    this.threshold = opts.degradedBelow ?? FILTER_KNOBS.degraded_below_coverage;
    this.weights = typeWeights(ep.registry, withRegistry({}, ep.registry));
  }

  done(): boolean {
    return this.t + 60 > this.ep.duration;
  }

  next(): TickPayload {
    this.t += 60;
    const now = this.t;
    const prev = this.cut;
    while (this.cut < this.byArrival.length && this.byArrival[this.cut].arrived_at <= now) this.cut++;
    const fresh = this.byArrival.slice(prev, this.cut); // only events with arrived_at <= now (R8)
    const record = this.engine.tick(fresh, now);

    const quarantined = new Set(record.quarantined.map((q) => q.event.id));
    const events: FeedEvent[] = [];
    let heartbeats = 0;
    for (const e of fresh) {
      const dup = this.seenIds.has(e.id);
      this.seenIds.add(e.id);
      if (e.kind === "heartbeat") {
        heartbeats++;
        continue;
      }
      events.push({
        id: e.id,
        arrived_at: e.arrived_at,
        occurred_at: e.occurred_at,
        source_id: e.source_id,
        source_type: e.source_type,
        zone_id: e.zone_id,
        kind: e.kind,
        severity: e.reported_severity,
        value: e.value,
        text: e.text,
        retracts: e.retracts,
        dup,
        quarantined: quarantined.has(e.id),
      });
    }

    const units: UnitSummary[] = this.engine
      .units()
      .filter((u) => u.n > 0)
      .map((u) => ({
        unit_id: u.unit_id,
        unit_type: u.unit_type,
        kind: u.kind,
        zone_id: u.zone_id,
        n: u.n,
        weight: u.weight,
        llr: cascadeLLR(u.hypothesis_contributions, record.probabilities),
        supports: supports(u.hypothesis_contributions),
        members: u.source_unit_ids,
      }));

    return {
      minute: now / 60,
      record,
      events,
      heartbeats,
      units,
      forecast_status: this.engine.chain().resolved,
      coverage_weighted: weightedCoverage(record.source_statuses, this.weights),
      degraded_threshold: this.threshold,
    };
  }
}

// Everything at once (demo-check and tests).
export function runAll(ep: Episode, opts: RunOptions = {}): TickPayload[] {
  const r = new EpisodeRunner(ep, opts);
  const out: TickPayload[] = [];
  while (!r.done()) out.push(r.next());
  return out;
}

// The ground-truth reveal sent with episode-end. Only after the last tick.
export function truthReveal(ep: Episode, group: string) {
  const t = ep.truth;
  return {
    episode_id: ep.episode_id,
    hypothesis: t.hypothesis,
    episode_type: t.episode_type,
    group,
    variant: t.variant,
    lookalike: t.lookalike,
    onset: t.onset,
    critical_time: t.critical_time,
    stage_times: t.stage_times,
    split_time: t.split_time,
    twin_role: t.twin_role,
    cutouts: t.cutouts,
    failed_gateways: t.failed_gateways.map((g) => ({ gateway_id: g.gateway_id, mode: g.mode, from: g.from, to: g.to })),
    rumor: t.rumor ? { zone_id: t.rumor.zone_id, reports: t.rumor.reports, from: t.rumor.from, to: t.rumor.to } : undefined,
  };
}
