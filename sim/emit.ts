// sim/emit.ts
// Turns an episode PLAN (what really happens) into DRAFTS (raw happenings with
// their true time). Delivery noise is added later in sim/noise.ts.
//
// Every emitter has its own random stream (rngFor(seed, label)) and walks
// forward in time. So two plans that are identical up to time T produce
// identical drafts up to time T. That is how twin episodes share a prefix.

import type { EventKind, Seconds, SourceType } from "../engine/types";
import {
  BACKGROUND_FP_PER_MIN,
  HEARTBEAT,
  MONITOR,
  MONSOON_RAIN_FP_MULT,
} from "./params";
import { rngFor } from "./rng";
import type { SimSourceEntry, SimWorld } from "./truth";
import { round3 } from "./world";

// One real (or fake) happening that makes sources emit for a while.
export interface Activation {
  id: string; // stable label, part of every random-stream name
  kind: EventKind; // the event kind its sources emit
  zone_id: string; // the zone the events are about
  source_ids: string[];
  start: Seconds;
  end: Seconds;
  rate: number; // events per source per minute at full strength
  ramp_s: number; // rate grows linearly from 0 over this many seconds
  fade_from?: Seconds; // rate falls linearly to 0 between fade_from and end
  severity: [number, number]; // reported_severity range
  intensity: number; // 0..1, pushes values toward the high end
  narrative_id?: string; // citizen reports: the story cluster they belong to
  is_stage: boolean; // part of the real physical chain (recorded in truth.stages)
}

export interface Blackout {
  gateway_id?: string; // whole gateway silent ...
  source_type?: SourceType; // ... or every source of a type (e.g. all cameras)
  from: Seconds;
  to: Seconds;
  backlog: boolean; // buffered events arrive in a burst at `to` instead of being lost
  monitor: boolean; // the gateway monitor notices (gateway_heartbeat_lost)
}

export interface Plan {
  duration: Seconds;
  weather: "normal" | "monsoon";
  tag: string; // "" on first build attempt, "r3:" on the 3rd reseed, etc.
  activations: Activation[];
  lies: { gateway_id: string; times: Seconds[] }[]; // identical fake readings
  blackouts: Blackout[];
  scripted: Draft[]; // one-off drafts (rumor bursts, duplicate storms)
  drift: Record<string, { from: number; to: number }>; // source_id -> reliability start/end
}

// A happening before delivery: true time, no arrival time yet.
export interface Draft {
  key: string; // unique, stable: names this draft's own random stream and its id
  true_t: Seconds;
  source: SimSourceEntry;
  kind: EventKind;
  zone_id: string;
  value?: number;
  severity?: number;
  text?: string;
  narrative_id?: string;
  is_lie: boolean;
  is_mimic: boolean;
  is_duplicate: boolean;
  is_background: boolean;
  can_mess: boolean; // false: never duplicated / retracted (heartbeats, monitor, lies)
}

const NATIVE_KIND: Record<SourceType, EventKind> = {
  rain_gauge: "rain_heavy",
  drainage_sensor: "drainage_anomaly",
  traffic_sensor: "traffic_slowdown",
  camera: "traffic_slowdown",
  utility: "power_comms_load",
  dispatch: "emergency_call_spike",
  hospital: "hospital_arrivals_unusual",
  citizen_report: "citizen_report",
  gateway: "gateway_heartbeat_lost",
};
export function nativeKind(type: SourceType): EventKind {
  return NATIVE_KIND[type];
}

// Value ranges [normal-life, real-anomaly] per kind, with units.
const VALUE_RANGE: Partial<Record<EventKind, { bg: [number, number]; real: [number, number] }>> = {
  rain_heavy: { bg: [8, 22], real: [22, 70] }, // mm per hour
  drainage_anomaly: { bg: [50, 78], real: [72, 100] }, // % of pipe capacity
  traffic_slowdown: { bg: [20, 45], real: [40, 85] }, // % speed drop
  emergency_call_spike: { bg: [8, 16], real: [14, 40] }, // calls per 5 minutes
  hospital_arrivals_unusual: { bg: [10, 18], real: [16, 40] }, // arrivals per hour
  power_comms_load: { bg: [70, 86], real: [84, 100] }, // % load
};

export function sampleValue(kind: EventKind, real: boolean, intensity: number, u: number): number | undefined {
  const r = VALUE_RANGE[kind];
  if (!r) return undefined;
  const [lo, hi] = real ? r.real : r.bg;
  // intensity pulls the draw toward the top of the range
  const x = real ? 0.5 * intensity + (1 - 0.5 * intensity) * u : u;
  return Math.round((lo + (hi - lo) * x) * 10) / 10;
}

const CITIZEN_TEXT: Partial<Record<EventKind, string[]>> = {
  rain_heavy: ["Very heavy rain here", "Rain is really bad on my street"],
  drainage_anomaly: ["Drains overflowing near {zone}", "Water coming up from the gutters in {zone}"],
  traffic_slowdown: ["Traffic stuck, water on road in {zone}", "Cars stalled in {zone}"],
  emergency_call_spike: ["People need help in {zone}", "Saw ambulances heading to {zone}"],
  citizen_report: ["Something happening in {zone}?", "Noise and lights in {zone}"],
};
export function citizenText(kind: EventKind, zoneName: string, u: number): string {
  const opts = CITIZEN_TEXT[kind] ?? CITIZEN_TEXT.citizen_report!;
  return opts[Math.floor(u * opts.length)].replace("{zone}", zoneName);
}

// Reliability of a source at time t (drifting sources get worse linearly).
export function reliabilityAt(plan: Plan, s: SimSourceEntry, t: Seconds): number {
  const d = plan.drift[s.source_id];
  if (!d) return s.true_reliability;
  return d.from + (d.to - d.from) * Math.min(1, t / plan.duration);
}

// Activation strength 0..1 at time t: ramp up, plateau, optional fade out.
export function strengthAt(a: Activation, t: Seconds): number {
  if (t < a.start || t >= a.end) return 0;
  let s = a.ramp_s > 0 ? Math.min(1, (t - a.start) / a.ramp_s) : 1;
  if (a.fade_from !== undefined && t > a.fade_from) s *= Math.max(0, (a.end - t) / (a.end - a.fade_from));
  return s;
}

// The "thinning" trick for a Poisson process whose rate changes over time:
// draw candidate times at the MAX rate, keep each with chance rate(t)/max.
function emitActivation(seed: number, plan: Plan, world: SimWorld, a: Activation, zoneName: string): Draft[] {
  const out: Draft[] = [];
  for (const sid of a.source_ids) {
    const src = world.sources.find((s) => s.source_id === sid)!;
    const rng = rngFor(seed, `${plan.tag}act${a.id}:${sid}`);
    const maxPerSec = a.rate / 60;
    let t = a.start;
    let k = 0;
    for (;;) {
      t += rng.exponential(maxPerSec);
      if (t >= a.end) break;
      const keep = rng.float();
      const uv = rng.float();
      const us = rng.float();
      const ut = rng.float();
      const p = strengthAt(a, t) * reliabilityAt(plan, src, t); // unreliable sources miss real happenings
      if (keep >= p) continue;
      const tt = Math.round(t);
      out.push({
        key: `${plan.tag}act${a.id}:${sid}#${k++}`,
        true_t: tt,
        source: src,
        kind: a.kind,
        zone_id: a.zone_id,
        value: sampleValue(a.kind, true, a.intensity, uv),
        severity: round2(a.severity[0] + (a.severity[1] - a.severity[0]) * us),
        text: a.kind === "citizen_report" ? citizenText(a.narrative_id ? "citizen_report" : a.kind, zoneName, ut) : undefined,
        narrative_id: a.narrative_id,
        is_lie: false,
        is_mimic: false,
        is_duplicate: false,
        is_background: false,
        can_mess: true,
      });
    }
  }
  return out;
}

// Normal city life: occasional false-positive blips from every source.
function emitBackground(seed: number, plan: Plan, world: SimWorld, src: SimSourceEntry): Draft[] {
  const base = BACKGROUND_FP_PER_MIN[src.source_type];
  if (base <= 0) return [];
  const weatherMult = plan.weather === "monsoon" && src.source_type === "rain_gauge" ? MONSOON_RAIN_FP_MULT : 1;
  const rateAt = (rel: number) => (base * (0.5 + 3 * (1 - rel)) * weatherMult) / 60;
  const d = plan.drift[src.source_id];
  const worstRel = Math.min(src.true_reliability, d ? d.to : 1);
  const maxPerSec = rateAt(worstRel);
  const rng = rngFor(seed, `${plan.tag}bg:${src.source_id}`);
  const out: Draft[] = [];
  let t = 0;
  let k = 0;
  for (;;) {
    t += rng.exponential(maxPerSec);
    if (t >= plan.duration) break;
    const keep = rng.float();
    const uv = rng.float();
    const us = rng.float();
    const uz = rng.float();
    const ut = rng.float();
    if (keep >= rateAt(reliabilityAt(plan, src, t)) / maxPerSec) continue;
    const kind = nativeKind(src.source_type);
    // dispatch lines and citizens can talk about any zone; sensors talk about their own
    const roaming = src.source_type === "dispatch" || src.source_type === "citizen_report";
    const zone = roaming ? world.zones[Math.floor(uz * world.zones.length)] : world.zones.find((z) => z.zone_id === src.zone_id)!;
    out.push({
      key: `${plan.tag}bg:${src.source_id}#${k++}`,
      true_t: Math.round(t),
      source: src,
      kind,
      zone_id: zone.zone_id,
      value: sampleValue(kind, false, 0, uv),
      severity: round2(0.15 + 0.4 * us),
      text: kind === "citizen_report" ? citizenText("citizen_report", zone.name, ut) : undefined,
      narrative_id: kind === "citizen_report" ? `n-bg-${src.source_id}-${k}` : undefined,
      is_lie: false,
      is_mimic: false,
      is_duplicate: false,
      is_background: true,
      can_mess: true,
    });
  }
  return out;
}

function emitHeartbeats(seed: number, plan: Plan, src: SimSourceEntry): Draft[] {
  const rng = rngFor(seed, `${plan.tag}hb:${src.source_id}`);
  const out: Draft[] = [];
  let t = rng.range(0, HEARTBEAT.interval_s);
  let k = 0;
  while (t < plan.duration) {
    out.push({
      key: `${plan.tag}hb:${src.source_id}#${k++}`,
      true_t: Math.round(t),
      source: src,
      kind: "heartbeat",
      zone_id: src.zone_id,
      is_lie: false,
      is_mimic: false,
      is_duplicate: false,
      is_background: true,
      can_mess: false,
    });
    t += HEARTBEAT.interval_s + rng.range(-HEARTBEAT.jitter_s, HEARTBEAT.jitter_s);
  }
  return out;
}

// A lying gateway: every sensor behind it reports the SAME anomalous value at once.
function emitLies(seed: number, plan: Plan, world: SimWorld): Draft[] {
  const out: Draft[] = [];
  for (const lie of plan.lies) {
    const sensors = world.sources.filter((s) => s.gateway_id === lie.gateway_id);
    const rng = rngFor(seed, `${plan.tag}lie:${lie.gateway_id}`);
    lie.times.forEach((t, b) => {
      const u = rng.float();
      for (const s of sensors) {
        const kind = nativeKind(s.source_type);
        out.push({
          key: `${plan.tag}lie:${lie.gateway_id}:${s.source_id}#${b}`,
          true_t: t,
          source: s,
          kind,
          zone_id: s.zone_id,
          value: 99.9, // the tell-tale sign: identical readings from very different sensors
          severity: round2(0.85 + 0.1 * u),
          is_lie: true,
          is_mimic: false,
          is_duplicate: false,
          is_background: false,
          can_mess: false,
        });
      }
    });
  }
  return out;
}

// The gateway monitor: "gateway X silent for 2+ minutes".
function emitMonitor(seed: number, plan: Plan, world: SimWorld): Draft[] {
  const out: Draft[] = [];
  plan.blackouts.forEach((b, i) => {
    if (!b.monitor || !b.gateway_id) return;
    const t = b.from + MONITOR.silence_s;
    if (t >= b.to || t >= plan.duration) return;
    const rng = rngFor(seed, `${plan.tag}mon:${i}`);
    const gw = world.gateways.find((g) => g.gateway_id === b.gateway_id)!;
    out.push({
      key: `${plan.tag}mon:${i}`,
      true_t: Math.round(t + rng.range(MONITOR.extra_delay_s[0], MONITOR.extra_delay_s[1])),
      source: gatewaySource(gw.gateway_id, gw.zone_ids[0]),
      kind: "gateway_heartbeat_lost",
      zone_id: gw.zone_ids[0],
      is_lie: false,
      is_mimic: false,
      is_duplicate: false,
      is_background: false,
      can_mess: false,
    });
  });
  return out;
}

export function gatewaySource(gateway_id: string, zone_id: string): SimSourceEntry {
  return {
    source_id: gateway_id,
    source_type: "gateway",
    zone_id,
    gateway_id,
    heartbeat_interval_s: 60,
    nominal_latency_s: 20,
    true_reliability: 1,
    clock_offset: 0,
  };
}

export function makeDrafts(seed: number, plan: Plan, world: SimWorld): Draft[] {
  const drafts: Draft[] = [];
  const zoneName = (id: string) => world.zones.find((z) => z.zone_id === id)!.name;
  for (const s of world.sources) {
    drafts.push(...emitBackground(seed, plan, world, s));
    drafts.push(...emitHeartbeats(seed, plan, s));
  }
  for (const a of plan.activations) drafts.push(...emitActivation(seed, plan, world, a, zoneName(a.zone_id)));
  drafts.push(...emitLies(seed, plan, world));
  drafts.push(...emitMonitor(seed, plan, world));
  drafts.push(...plan.scripted);
  return drafts.filter((d) => d.true_t >= 0 && d.true_t < plan.duration);
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
