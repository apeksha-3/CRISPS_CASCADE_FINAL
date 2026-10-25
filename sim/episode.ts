// sim/episode.ts
// Generate one labeled Episode (or a twin pair) from a type and a seed.
// Same (type, seed, options) => byte-identical JSON. No Math.random, no clocks.

import type { Event, EventKind, Hypothesis } from "../engine/types";
import { type Activation, makeDrafts, type Plan } from "./emit";
import {
  type Ctx,
  CHAIN_DEFAULTS,
  planChain,
  planDuplicateStorm,
  planFluCluster,
  planGatewayFailure,
  planGatewayOutageLookalike,
  planIsolated,
  planRumor,
  planStormCalls,
} from "./builders";
import { deliver } from "./noise";
import {
  CASCADE_LAGS,
  DEFAULT_DURATION_S,
  DRIFT,
  DURATION_MIN,
  EVENT_COUNT_WARN,
  LOOKALIKE_CHECK,
  SURGE_RATE_MULT,
  TWIN,
} from "./params";
import { rngFor } from "./rng";
import { type Episode, type EpisodeType, type GroundTruth, LOOKALIKE_LABEL, type LookalikeType, publicRegistry } from "./truth";
import { buildWorld } from "./world";

export type ScenarioName =
  | Exclude<EpisodeType, "lookalike" | "twin">
  | LookalikeType;

export const SCENARIO_NAMES: ScenarioName[] = [
  "noise", "sensor_failure", "isolated_incident", "cascade",
  "rain_only", "storm_calls", "flu_cluster", "gateway_outage",
  "cutout", "rumor_wave", "duplicate_storm", "surge", "drifting",
];
const LOOKALIKES: LookalikeType[] = ["rain_only", "storm_calls", "flu_cluster", "gateway_outage"];

export interface BuildOptions {
  variant?: string; // sensor_failure: outage|lie, cutout: cameras|gateway, rumor_wave: pure|with_real
  base?: "noise" | "isolated_incident" | "cascade"; // for cutout / drifting
  weather?: "normal" | "monsoon";
  fuzz?: boolean; // add malformed events (for quarantine tests)
  episode_id?: string;
}

const MIN = 60;
const HYP: Record<string, Hypothesis> = {
  noise: "NOISE",
  sensor_failure: "SENSOR_FAILURE",
  isolated_incident: "ISOLATED_INCIDENT",
  cascade: "CASCADING_CRISIS",
  surge: "CASCADING_CRISIS",
  duplicate_storm: "ISOLATED_INCIDENT",
};

function newCtx(seed: number, tag: string, type: string, weather: "normal" | "monsoon", fixedDuration?: number): Ctx {
  const rng = rngFor(seed, `${tag}plan`);
  const world = buildWorld(rngFor(seed, `${tag}world`));
  const range = DURATION_MIN[type] ?? DURATION_MIN.default;
  const duration = fixedDuration ?? rng.int(range[0], range[1]) * MIN;
  const plan: Plan = { duration, weather, tag, activations: [], lies: [], blackouts: [], scripted: [], drift: {} };
  const truth: GroundTruth = {
    hypothesis: "NOISE",
    episode_type: "noise",
    stage_times: {},
    stages: [],
    build_attempt: 0,
    cutouts: [],
    failed_gateways: [],
    surge: false,
    drifting_sources: [],
    weather,
    sources: world.sources,
    event_truths: {},
  };
  return { seed, world, rng, plan, truth };
}

const isLongType = (t: string) => t === "cascade" || t === "surge";

// Fill the plan for one scenario. Returns the episode type and true hypothesis.
function fillPlan(ctx: Ctx, name: ScenarioName, opts: BuildOptions): { type: EpisodeType; hyp: Hypothesis } {
  const { rng, truth, plan } = ctx;
  switch (name) {
    case "noise":
      return { type: "noise", hyp: "NOISE" };
    case "sensor_failure": {
      const mode = (opts.variant ?? (rng.chance(0.5) ? "outage" : "lie")) as "outage" | "lie";
      truth.variant = mode;
      planGatewayFailure(ctx, mode);
      return { type: "sensor_failure", hyp: "SENSOR_FAILURE" };
    }
    case "isolated_incident":
      planIsolated(ctx);
      return { type: "isolated_incident", hyp: "ISOLATED_INCIDENT" };
    case "cascade":
    case "surge": {
      const surge = name === "surge";
      planChain(ctx, {
        onset: rng.int(CASCADE_LAGS.onset_s[0], CASCADE_LAGS.onset_s[1]),
        rateMult: surge ? SURGE_RATE_MULT : 1,
        downstream: true,
        spreadProb: surge ? 1 : CHAIN_DEFAULTS.spreadProb,
      });
      truth.surge = surge;
      return { type: name, hyp: "CASCADING_CRISIS" };
    }
    case "rain_only":
      planChain(ctx, { onset: rng.int(CASCADE_LAGS.onset_s[0], CASCADE_LAGS.onset_s[1]), rateMult: 1, downstream: false, spreadProb: 0 });
      break;
    case "storm_calls":
      planStormCalls(ctx);
      break;
    case "flu_cluster":
      planFluCluster(ctx);
      break;
    case "gateway_outage":
      planGatewayOutageLookalike(ctx);
      break;
    case "cutout": {
      const variant = opts.variant ?? (rng.chance(0.6) ? "cameras" : "gateway");
      // a gateway cutout on a quiet day would just be a sensor failure, so give it a real situation
      const base = opts.base ?? (variant === "gateway" ? rng.pick(["isolated_incident", "cascade"] as const) : rng.pick(["noise", "isolated_incident", "cascade"] as const));
      const inner = fillPlan(ctx, base, {});
      truth.variant = variant;
      truth.base_type = base;
      const from = rng.int(8 * MIN, 20 * MIN);
      if (variant === "cameras") {
        const to = rng.chance(0.5) ? plan.duration : Math.min(plan.duration, from + rng.int(10, 20) * MIN);
        plan.blackouts.push({ source_type: "camera", from, to, backlog: false, monitor: false });
        truth.cutouts.push({ source_type: "camera", from, to });
      } else {
        const g = rng.pick(ctx.world.gateways).gateway_id;
        const to = Math.min(plan.duration, from + rng.int(10, 20) * MIN);
        plan.blackouts.push({ gateway_id: g, from, to, backlog: false, monitor: true });
        truth.cutouts.push({ gateway_id: g, from, to });
      }
      return { type: "cutout", hyp: inner.hyp };
    }
    case "rumor_wave": {
      const withReal = (opts.variant ?? (rng.chance(0.5) ? "with_real" : "pure")) === "with_real";
      truth.variant = withReal ? "with_real" : "pure";
      const from = rng.int(5 * MIN, 20 * MIN);
      const zone = rng.pick(ctx.world.zones).zone_id;
      if (withReal) planIsolated(ctx, from + rng.int(-60, 60), zone);
      planRumor(ctx, zone, from);
      truth.rumor!.with_real_event = withReal;
      return { type: "rumor_wave", hyp: withReal ? "ISOLATED_INCIDENT" : "NOISE" };
    }
    case "duplicate_storm": {
      const zone = planIsolated(ctx);
      planDuplicateStorm(ctx, zone, (truth.onset ?? 300) + rng.int(60, 180));
      return { type: "duplicate_storm", hyp: "ISOLATED_INCIDENT" };
    }
    case "drifting": {
      const base = opts.base ?? rng.pick(["noise", "cascade"] as const);
      const inner = fillPlan(ctx, base, {});
      truth.base_type = base;
      const sensors = ctx.world.sources.filter((s) => s.gateway_id !== undefined);
      const n = rng.int(DRIFT.sources[0], DRIFT.sources[1]);
      for (const s of rng.shuffle(sensors).slice(0, n).sort((a, b) => (a.source_id < b.source_id ? -1 : 1))) {
        plan.drift[s.source_id] = { from: s.true_reliability, to: DRIFT.end_reliability };
        truth.drifting_sources.push({ source_id: s.source_id, from_reliability: s.true_reliability, to_reliability: DRIFT.end_reliability });
      }
      return { type: "drifting", hyp: inner.hyp };
    }
  }
  // lookalikes fall through to here
  const look = name as LookalikeType;
  truth.lookalike = look;
  return { type: "lookalike", hyp: LOOKALIKE_LABEL[look] };
}

export function countSignalEvents(events: Event[]): number {
  return events.filter((e) => e.kind !== "heartbeat").length;
}

function assemble(ctx: Ctx, type: EpisodeType, hyp: Hypothesis, attempt: number, opts: BuildOptions, defaultId: string): Episode {
  const { seed, world, plan, truth } = ctx;
  const delivered = deliver(seed, plan, makeDrafts(seed, plan, world), { fuzz: opts.fuzz });
  truth.hypothesis = hyp;
  truth.episode_type = type;
  truth.build_attempt = attempt;
  truth.event_truths = delivered.truths;
  checkIds(delivered.events);
  const ep: Episode = {
    episode_id: opts.episode_id ?? defaultId,
    seed,
    type,
    duration: plan.duration,
    registry: publicRegistry(world),
    events: delivered.events,
    truth,
  };
  const n = countSignalEvents(ep.events);
  if (n < EVENT_COUNT_WARN.min || n > EVENT_COUNT_WARN.max) {
    console.warn(`[sim] warning: ${ep.episode_id} has ${n} non-heartbeat events (healthy range ${EVENT_COUNT_WARN.min}-${EVENT_COUNT_WARN.max}); check sim/params.ts`);
  }
  return ep;
}

// Two different events must never share an id (only same-id retransmissions may).
function checkIds(events: Event[]): void {
  const seen = new Map<string, Event>();
  for (const e of events) {
    const prev = seen.get(e.id);
    if (prev && (prev.source_id !== e.source_id || prev.occurred_at !== e.occurred_at || prev.kind !== e.kind)) {
      throw new Error(`id collision: ${e.id}`);
    }
    seen.set(e.id, e);
  }
}

// Kinds that only real happenings (not background blips) produced in the first window.
function earlySignalKinds(ep: Episode, window: number): Set<EventKind> {
  const out = new Set<EventKind>();
  for (const e of ep.events) {
    if (e.arrived_at > window || e.kind === "heartbeat" || e.kind === "retraction") continue;
    if (ep.truth.event_truths[e.id]?.is_background) continue;
    out.add(e.kind);
  }
  return out;
}
const CASCADE_KINDS: EventKind[] = ["rain_heavy", "drainage_anomaly", "traffic_slowdown", "emergency_call_spike", "hospital_arrivals_unusual", "power_comms_load", "citizen_report"];

export function generateEpisode(name: ScenarioName, seed: number, opts: BuildOptions = {}): Episode {
  const weather = opts.weather ?? "normal";
  for (let attempt = 0; attempt < LOOKALIKE_CHECK.max_attempts; attempt++) {
    const tag = attempt === 0 ? "" : `r${attempt}:`;
    const ctx = newCtx(seed, tag, name, weather, isLongType(name) ? DEFAULT_DURATION_S : undefined);
    const { type, hyp } = fillPlan(ctx, name, opts);
    const ep = assemble(ctx, type, hyp, attempt, opts, `${name}-${seed}`);
    if (name === "rain_only") {
      // A rain-only day must look like a cascade early on: >= 3 shared signal kinds in the first 8 minutes.
      const shared = [...earlySignalKinds(ep, LOOKALIKE_CHECK.window_s)].filter((k) => CASCADE_KINDS.includes(k));
      if (shared.length < LOOKALIKE_CHECK.min_shared_kinds) continue;
    }
    return ep;
  }
  throw new Error(`could not build a valid ${name} episode for seed ${seed}`);
}

// ---------------- Twin pairs ----------------
// Both twins come from the SAME plan up to split_time. After it, twin A keeps
// cascading; twin B's rain stops and everything fades (rain-only, label NOISE).
// Because every emitter has its own random stream and only post-split settings
// change, all events with arrived_at <= split are byte-identical.
export function generateTwinPair(seed: number, opts: BuildOptions = {}): [Episode, Episode] {
  const weather = opts.weather ?? "normal";
  const pairId = opts.episode_id ?? `twin-${seed}`;
  for (let attempt = 0; attempt < TWIN.max_attempts; attempt++) {
    const tag = attempt === 0 ? "" : `r${attempt}:`;
    const ctxA = newCtx(seed, tag, "cascade", weather, DEFAULT_DURATION_S);
    planChain(ctxA, { onset: ctxA.rng.int(CASCADE_LAGS.twin_onset_s[0], CASCADE_LAGS.twin_onset_s[1]), rateMult: 1, downstream: true, spreadProb: CHAIN_DEFAULTS.spreadProb });
    const critical = ctxA.truth.critical_time;
    if (critical === undefined) continue;
    // split on a whole minute, 1-2.5 minutes before the first hospital signal, clamped to minutes 5..9
    const raw = Math.floor((critical - ctxA.rng.int(60, 150)) / MIN) * MIN;
    const split = Math.min(TWIN.split_max_s, Math.max(TWIN.split_min_s, raw));
    const downstreamEarly = ctxA.plan.activations.some(
      (a) => (a.kind === "hospital_arrivals_unusual" || a.kind === "power_comms_load") && a.start <= split + 30,
    );
    if (downstreamEarly) continue;

    const ctxB = newCtx(seed, tag, "cascade", weather, DEFAULT_DURATION_S);
    ctxB.plan.activations = benignContinuation(ctxA.plan.activations, split, rngFor(seed, `${tag}twinB`));
    ctxB.truth.onset = ctxA.truth.onset;
    for (const a of ctxB.plan.activations) {
      ctxB.truth.stages.push({ kind: a.kind, zone_id: a.zone_id, start: a.start, end: a.end });
      const prev = ctxB.truth.stage_times[a.kind];
      if (prev === undefined || a.start < prev) ctxB.truth.stage_times[a.kind] = a.start;
    }
    for (const c of [ctxA, ctxB]) {
      c.truth.twin_pair_id = pairId;
      c.truth.split_time = split;
    }
    ctxA.truth.twin_role = "cascade";
    ctxB.truth.twin_role = "benign";
    ctxB.truth.lookalike = "rain_only";

    const a = assemble(ctxA, "twin", "CASCADING_CRISIS", attempt, { ...opts, episode_id: `${pairId}-A` }, "");
    const prefixA = a.events.filter((e) => e.arrived_at <= split);
    if (countSignalEvents(prefixA) < TWIN.min_prefix_events) continue;
    const b = assemble(ctxB, "twin", "NOISE", attempt, { ...opts, episode_id: `${pairId}-B` }, "");
    const prefixB = b.events.filter((e) => e.arrived_at <= split);
    if (JSON.stringify(prefixA) !== JSON.stringify(prefixB)) throw new Error(`twin prefix mismatch for seed ${seed} (bug)`);
    return [a, b];
  }
  throw new Error(`could not build a valid twin pair for seed ${seed}`);
}

// Copy the cascade plan, drop everything that starts after the split and every
// downstream (hospital / power) stage, and make the rest fade out after the split.
function benignContinuation(acts: Activation[], split: number, rng: ReturnType<typeof rngFor>): Activation[] {
  const rainFade = split + rng.int(1, 4) * MIN;
  const rainEnd = rainFade + rng.int(3, 6) * MIN;
  const out: Activation[] = [];
  for (const a of acts) {
    if (a.start > split) continue;
    if (a.kind === "hospital_arrivals_unusual" || a.kind === "power_comms_load") continue;
    const fade_from = a.kind === "rain_heavy" ? rainFade : rainFade + 2 * MIN;
    const end = a.kind === "rain_heavy" ? rainEnd : fade_from + rng.int(3, 6) * MIN;
    out.push({ ...a, fade_from, end: Math.min(a.end, end) });
  }
  return out;
}
