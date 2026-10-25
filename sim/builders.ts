// sim/builders.ts
// Plan builders: one small function per kind of situation. Each one adds
// "activations" (things that really happen) to the plan and records them
// in the ground truth. No events are made here; see sim/emit.ts.

import type { EventKind, Seconds } from "../engine/types";
import type { Activation, Draft, Plan } from "./emit";
import {
  CASCADE_BRANCH,
  CASCADE_LAGS,
  DUPLICATE_STORM_REPORTS,
  GATEWAY_FAIL,
  RAIN_ONLY,
  RUMOR,
  STAGE_RAMP_S,
  STAGE_RATE_PER_MIN as RATE,
} from "./params";
import { stableId, type Rng } from "./rng";
import type { GroundTruth, SimWorld } from "./truth";
import { nearestHospital, round3, sourcesOfType } from "./world";

export interface Ctx {
  seed: number;
  world: SimWorld;
  rng: Rng; // the plan's own random stream
  plan: Plan;
  truth: GroundTruth;
}

const MIN = 60;
const lag = (rng: Rng, l: { mean: number; sd: number }) => Math.max(30, Math.round(rng.normal(l.mean, l.sd)));
const zoneName = (ctx: Ctx, z: string) => ctx.world.zones.find((x) => x.zone_id === z)!.name;
const neighbours = (ctx: Ctx, z: string) => ctx.world.zones.find((x) => x.zone_id === z)!.neighbours;

// Add one activation. Real physical stages are also written to truth.stages.
export function addActivation(
  ctx: Ctx,
  a: Omit<Activation, "id" | "ramp_s" | "severity" | "intensity" | "is_stage"> & Partial<Activation>,
): Activation {
  const act: Activation = {
    id: String(ctx.plan.activations.length),
    ramp_s: STAGE_RAMP_S,
    severity: [0.45, 0.95],
    intensity: 0.6,
    is_stage: true,
    ...a,
    start: Math.round(a.start),
    end: Math.round(Math.min(a.end, ctx.plan.duration)),
  };
  if (act.source_ids.length === 0 || act.start >= act.end) return act; // nothing would happen
  ctx.plan.activations.push(act);
  if (act.is_stage) {
    ctx.truth.stages.push({ kind: act.kind, zone_id: act.zone_id, start: act.start, end: act.end });
    const prev = ctx.truth.stage_times[act.kind];
    if (prev === undefined || act.start < prev) ctx.truth.stage_times[act.kind] = act.start;
  }
  return act;
}

const ids = (xs: { source_id: string }[]) => xs.map((s) => s.source_id);
function citizens(ctx: Ctx, n: number): string[] {
  return ctx.rng.shuffle(ids(sourcesOfType(ctx.world, "citizen_report"))).slice(0, n).sort();
}
function narrative(ctx: Ctx, label: string): string {
  return "n-" + stableId(ctx.seed, ctx.plan.tag + label).slice(0, 8);
}

// ---------------- Cascade (and its rain-only cousin) ----------------
// rain -> drainage -> traffic -> emergency calls -> hospital -> power/comms,
// each stage starting a random lag after the previous one, zone by zone.
export interface ChainOptions {
  onset: Seconds;
  rateMult: number;
  downstream: boolean; // false = rain-only: no hospital / power, no spread
  spreadProb: number;
}

export function planChain(ctx: Ctx, o: ChainOptions): void {
  const { rng, plan } = ctx;
  const end = plan.duration;
  const z0 = rng.pick(ctx.world.zones).zone_id;
  const rainZones = [z0, ...rng.shuffle(neighbours(ctx, z0)).slice(0, CASCADE_BRANCH.max_rain_neighbours)];
  const hospitalStart = new Map<string, number>();
  const rainOnly = !o.downstream;
  // rain-only: rain stops after a while and everything downstream fades out
  const rainEnd = rainOnly ? o.onset + rng.int(RAIN_ONLY.rain_minutes[0], RAIN_ONLY.rain_minutes[1]) * MIN : end;
  const fadeEnd = rainOnly ? rainEnd + rng.int(RAIN_ONLY.fade_after_rain_minutes[0], RAIN_ONLY.fade_after_rain_minutes[1]) * MIN : end;
  const calm = rainOnly ? { fade_from: rainEnd, end: fadeEnd } : { end };
  ctx.truth.onset = o.onset;

  const floodZone = (z: string, first: Seconds) => {
    const d = first + lag(rng, CASCADE_LAGS.drainage);
    addActivation(ctx, { kind: "drainage_anomaly", zone_id: z, source_ids: ids(sourcesOfType(ctx.world, "drainage_sensor", z)), start: d, rate: RATE.drainage_anomaly * o.rateMult, ...calm });
    const t = d + lag(rng, CASCADE_LAGS.traffic);
    const roadSources = [...sourcesOfType(ctx.world, "traffic_sensor", z), ...sourcesOfType(ctx.world, "camera", z)];
    addActivation(ctx, { kind: "traffic_slowdown", zone_id: z, source_ids: ids(roadSources), start: t, rate: RATE.traffic_slowdown * o.rateMult, ...calm });
    addActivation(ctx, { kind: "citizen_report", zone_id: z, source_ids: citizens(ctx, 3), start: t, rate: RATE.citizen_report * o.rateMult, narrative_id: narrative(ctx, `chain:${z}`), ...calm });
    return t;
  };
  const callsZone = (z: string, at: Seconds) => {
    const mult = o.rateMult * (rainOnly ? RAIN_ONLY.calls_rate_mult : 1);
    addActivation(ctx, { kind: "emergency_call_spike", zone_id: z, source_ids: ids(sourcesOfType(ctx.world, "dispatch")), start: at, rate: RATE.emergency_call_spike * mult, ...calm });
    if (!o.downstream) return;
    const h = nearestHospital(ctx.world, z);
    const hs = at + lag(rng, CASCADE_LAGS.hospital);
    hospitalStart.set(h.source_id, Math.min(hospitalStart.get(h.source_id) ?? Infinity, hs));
    const ps = at + lag(rng, CASCADE_LAGS.power);
    addActivation(ctx, { kind: "power_comms_load", zone_id: z, source_ids: ids(sourcesOfType(ctx.world, "utility", z)), start: ps, rate: RATE.power_comms_load * o.rateMult, end });
  };

  for (const z of rainZones) {
    const r = o.onset + (z === z0 ? 0 : rng.int(CASCADE_LAGS.rain_neighbour_s[0], CASCADE_LAGS.rain_neighbour_s[1]));
    addActivation(ctx, { kind: "rain_heavy", zone_id: z, source_ids: ids(sourcesOfType(ctx.world, "rain_gauge", z)), start: r, rate: RATE.rain_heavy * o.rateMult, end: rainOnly ? rainEnd : end });
    const floods = z === z0 || rng.chance(CASCADE_BRANCH.neighbour_drainage_prob);
    if (!floods) continue;
    const t = floodZone(z, r);
    const c = t + lag(rng, CASCADE_LAGS.calls);
    if (!rainOnly || rng.chance(0.8)) callsZone(z, c);
    // branching: the crisis spreads to a dry neighbour zone
    if (o.downstream && rng.chance(o.spreadProb)) {
      const dry = neighbours(ctx, z).filter((n) => !rainZones.includes(n));
      if (dry.length > 0) {
        const nz = rng.pick(dry);
        const s = c + lag(rng, CASCADE_LAGS.spread);
        callsZone(nz, s);
        addActivation(ctx, { kind: "traffic_slowdown", zone_id: nz, source_ids: ids(sourcesOfType(ctx.world, "traffic_sensor", nz)), start: s, rate: RATE.traffic_slowdown * o.rateMult, end });
      }
    }
  }
  for (const [hid, hs] of [...hospitalStart.entries()].sort()) {
    const h = ctx.world.sources.find((s) => s.source_id === hid)!;
    addActivation(ctx, { kind: "hospital_arrivals_unusual", zone_id: h.zone_id, source_ids: [hid], start: hs, rate: RATE.hospital_arrivals_unusual * o.rateMult, end });
  }
  if (o.downstream && ctx.truth.stage_times.hospital_arrivals_unusual !== undefined) {
    ctx.truth.critical_time = ctx.truth.stage_times.hospital_arrivals_unusual;
  }
}

// ---------------- Isolated incident ----------------
// One zone: calls spike, a little traffic, a small hospital blip. No spread.
export function planIsolated(ctx: Ctx, at?: Seconds, zone?: string): string {
  const { rng } = ctx;
  const z = zone ?? rng.pick(ctx.world.zones).zone_id;
  const start = at ?? rng.int(3 * MIN, 15 * MIN);
  const stop = start + rng.int(12, 20) * MIN;
  const fade = { fade_from: stop - 4 * MIN, end: stop };
  const variant = rng.chance(0.5) ? "flood" : "accident";
  ctx.truth.variant = ctx.truth.variant ?? variant;
  ctx.truth.onset = start;
  if (variant === "flood") {
    addActivation(ctx, { kind: "drainage_anomaly", zone_id: z, source_ids: ids(sourcesOfType(ctx.world, "drainage_sensor", z)), start, rate: RATE.drainage_anomaly, ...fade });
  } else {
    const road = rng.shuffle(ids(sourcesOfType(ctx.world, "traffic_sensor", z))).slice(0, 1);
    addActivation(ctx, { kind: "traffic_slowdown", zone_id: z, source_ids: road, start, rate: RATE.traffic_slowdown * 2, ...fade });
  }
  const calls = start + lag(rng, CASCADE_LAGS.calls);
  addActivation(ctx, { kind: "emergency_call_spike", zone_id: z, source_ids: ids(sourcesOfType(ctx.world, "dispatch")), start: calls, rate: RATE.emergency_call_spike, ...fade });
  addActivation(ctx, { kind: "citizen_report", zone_id: z, source_ids: citizens(ctx, 3), start: start + MIN, rate: RATE.citizen_report, narrative_id: narrative(ctx, `iso:${z}`), ...fade });
  const h = nearestHospital(ctx.world, z);
  const hs = calls + lag(rng, CASCADE_LAGS.hospital);
  addActivation(ctx, { kind: "hospital_arrivals_unusual", zone_id: h.zone_id, source_ids: [h.source_id], start: hs, end: hs + rng.int(4, 6) * MIN, rate: RATE.hospital_arrivals_unusual, intensity: 0.2 });
  return z;
}

// ---------------- Lookalikes ----------------
export function planStormCalls(ctx: Ctx): void {
  const { rng } = ctx;
  const onset = rng.int(MIN, 4 * MIN);
  const stop = onset + rng.int(15, 25) * MIN;
  ctx.truth.onset = onset;
  for (const z of rng.shuffle(ctx.world.zones).slice(0, rng.int(2, 3))) {
    addActivation(ctx, { kind: "rain_heavy", zone_id: z.zone_id, source_ids: ids(sourcesOfType(ctx.world, "rain_gauge", z.zone_id)), start: onset + rng.int(0, 90), end: stop, rate: RATE.rain_heavy * 0.6, intensity: 0.2 });
  }
  const callZones = rng.shuffle(ctx.world.zones).slice(0, rng.int(3, 5));
  callZones.forEach((z, i) => {
    const s = onset + MIN + i * rng.int(30, 90);
    addActivation(ctx, { kind: "emergency_call_spike", zone_id: z.zone_id, source_ids: ids(sourcesOfType(ctx.world, "dispatch")), start: s, fade_from: stop - 5 * MIN, end: stop, rate: RATE.emergency_call_spike, intensity: 0.3 });
    if (i < 2) addActivation(ctx, { kind: "citizen_report", zone_id: z.zone_id, source_ids: citizens(ctx, 3), start: s, end: stop, rate: RATE.citizen_report, narrative_id: narrative(ctx, `storm:${z.zone_id}`) });
  });
}

export function planFluCluster(ctx: Ctx): void {
  const { rng } = ctx;
  const hs = rng.shuffle(sourcesOfType(ctx.world, "hospital")).slice(0, rng.int(2, 3));
  const onset = rng.int(2 * MIN, 10 * MIN);
  ctx.truth.onset = onset;
  hs.forEach((h, i) => {
    addActivation(ctx, { kind: "hospital_arrivals_unusual", zone_id: h.zone_id, source_ids: [h.source_id], start: onset + i * rng.int(60, 240), end: ctx.plan.duration, rate: RATE.hospital_arrivals_unusual, ramp_s: 10 * MIN, intensity: 0.4 });
  });
  addActivation(ctx, { kind: "citizen_report", zone_id: hs[0].zone_id, source_ids: citizens(ctx, 2), start: onset + 5 * MIN, end: ctx.plan.duration, rate: 0.1, narrative_id: narrative(ctx, "flu") });
}

// A gateway goes silent. mode "lie": instead, all its sensors report the same fake value.
export function planGatewayFailure(ctx: Ctx, mode: "outage" | "lie", backlogProb = GATEWAY_FAIL.backlog_prob): void {
  const { rng, plan } = ctx;
  const g = rng.chance(0.5) ? ctx.world.gateways[0] : rng.pick(ctx.world.gateways);
  const from = rng.int(GATEWAY_FAIL.start_s[0], GATEWAY_FAIL.start_s[1]);
  ctx.truth.onset = from;
  if (mode === "outage") {
    const to = Math.min(plan.duration, from + rng.int(GATEWAY_FAIL.outage_minutes[0], GATEWAY_FAIL.outage_minutes[1]) * MIN);
    const backlog = rng.chance(backlogProb);
    plan.blackouts.push({ gateway_id: g.gateway_id, from, to, backlog, monitor: true });
    ctx.truth.failed_gateways.push({ gateway_id: g.gateway_id, mode, from, to, backlog });
  } else {
    const n = rng.int(GATEWAY_FAIL.lie_bursts[0], GATEWAY_FAIL.lie_bursts[1]);
    const times = Array.from({ length: n }, (_, i) => from + i * MIN);
    plan.lies.push({ gateway_id: g.gateway_id, times });
    ctx.truth.failed_gateways.push({ gateway_id: g.gateway_id, mode, from, to: from + n * MIN, backlog: false });
  }
}

export function planGatewayOutageLookalike(ctx: Ctx): void {
  planGatewayFailure(ctx, "outage", 0.7);
  // mild rain at the same time makes "sensors going dark" look like storm damage
  const from = ctx.truth.failed_gateways[0].from;
  for (const z of ctx.rng.shuffle(ctx.world.zones).slice(0, 2)) {
    addActivation(ctx, { kind: "rain_heavy", zone_id: z.zone_id, source_ids: ids(sourcesOfType(ctx.world, "rain_gauge", z.zone_id)), start: from - ctx.rng.int(0, 3 * MIN), end: from + 15 * MIN, rate: RATE.rain_heavy * 0.6, intensity: 0.3 });
  }
}

// ---------------- Specials ----------------
const RUMOR_TEXT = [
  "BREAKING: bridge collapsed in {zone}, many people trapped!!",
  "Bridge collapse in {zone}, people trapped, share this!",
  "Heard the bridge in {zone} collapsed, many trapped",
  "bridge collapsed {zone} many trapped pls share",
];

// Many near-identical citizen reports, one narrative, no physical corroboration.
export function planRumor(ctx: Ctx, zone: string, from: Seconds): void {
  const { rng, plan } = ctx;
  const n = rng.int(RUMOR.reports[0], RUMOR.reports[1]);
  const span = rng.int(RUMOR.spread_minutes[0], RUMOR.spread_minutes[1]) * MIN;
  const nid = narrative(ctx, "rumor");
  const cits = sourcesOfType(ctx.world, "citizen_report");
  for (let i = 0; i < n; i++) {
    plan.scripted.push(scripted(ctx, `rumor#${i}`, rng.pick(cits).source_id, from + Math.round(rng.range(0, span)), zone, {
      text: rng.pick(RUMOR_TEXT).replace("{zone}", zoneName(ctx, zone)),
      narrative_id: nid,
      severity: round3(rng.range(0.8, 0.95)),
      is_mimic: true,
    }));
  }
  ctx.truth.rumor = { narrative_id: nid, zone_id: zone, from, to: from + span, reports: n, with_real_event: false };
}

// 50 reports of ONE incident, each with a different id.
export function planDuplicateStorm(ctx: Ctx, zone: string, from: Seconds): void {
  const { rng, plan } = ctx;
  const nid = narrative(ctx, "dupstorm");
  const span = rng.int(3, 6) * MIN;
  const cits = sourcesOfType(ctx.world, "citizen_report");
  for (let i = 0; i < DUPLICATE_STORM_REPORTS; i++) {
    plan.scripted.push(scripted(ctx, `dup#${i}`, rng.pick(cits).source_id, from + Math.round(rng.range(0, span)), zone, {
      text: `Car crash on the main road in ${zoneName(ctx, zone)}${i % 3 === 0 ? "!" : ""}`,
      narrative_id: nid,
      severity: round3(rng.range(0.6, 0.8)),
      is_duplicate: i > 0,
    }));
  }
  ctx.truth.duplicate_storm = { narrative_id: nid, zone_id: zone, reports: DUPLICATE_STORM_REPORTS };
}

function scripted(
  ctx: Ctx,
  label: string,
  source_id: string,
  t: Seconds,
  zone: string,
  x: { text: string; narrative_id: string; severity: number; is_mimic?: boolean; is_duplicate?: boolean },
): Draft {
  return {
    key: `${ctx.plan.tag}${label}`,
    true_t: t,
    source: ctx.world.sources.find((s) => s.source_id === source_id)!,
    kind: "citizen_report" as EventKind,
    zone_id: zone,
    severity: x.severity,
    text: x.text,
    narrative_id: x.narrative_id,
    is_lie: false,
    is_mimic: x.is_mimic ?? false,
    is_duplicate: x.is_duplicate ?? false,
    is_background: false,
    can_mess: true,
  };
}

export const CHAIN_DEFAULTS = { spreadProb: CASCADE_BRANCH.spread_prob };
