// real/obs.ts
// The common shape every adapter produces, and the step that turns it into an engine Event.
//
// An Obs is a REAL observation (real time, real value) with no delivery delay yet.
// finalize() adds the simulator's delay model, seeded by the episode id, and cuts the
// episode window. Hidden fields do not exist here: an Event has no truth in it.

import type { Event, EventKind, SourceType } from "../engine/types";
import { DELAY, EPISODE_S, NOMINAL_LATENCY_S } from "./params";

export interface Obs {
  id: string; // stable and unique, e.g. "311:12345678"
  source_id: string;
  source_type: SourceType;
  gateway_id?: string;
  zone_id: string;
  kind: EventKind;
  t_ms: number; // real UTC instant of the observation
  value?: number;
  reported_severity?: number;
  text?: string;
}

// Rows an adapter could not use, counted by reason. Nothing is silently dropped, nothing is invented.
export class Unmapped {
  counts: Record<string, number> = {};
  add(reason: string, n = 1): void {
    this.counts[reason] = (this.counts[reason] ?? 0) + n;
  }
  merge(other: Unmapped): void {
    for (const [k, v] of Object.entries(other.counts)) this.add(k, v);
  }
}

// ---- tiny seeded random numbers (a copy of the idea in sim/rng.ts; this folder must not import sim/) ----
function hash32(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}
function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const seedOf = (s: string) => hash32(s);

// Delivery delay for one event: depends only on (episode id, event id, source type), so reruns are identical.
export function delayFor(episodeId: string, eventId: string, type: SourceType): number {
  const rnd = mulberry32(hash32(`${episodeId}|${eventId}`));
  const u1 = Math.max(1e-12, rnd());
  const u2 = rnd();
  const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * DELAY.spread; // normal(0, spread)
  const late = rnd() < DELAY.late_prob;
  const lateExtra = DELAY.late_extra_s[0] + rnd() * (DELAY.late_extra_s[1] - DELAY.late_extra_s[0]);
  let d = Math.min(DELAY.max_s, Math.max(DELAY.min_s, NOMINAL_LATENCY_S[type] * Math.exp(n)));
  if (late) d += lateExtra;
  return Math.round(d);
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
export { round1, round2 };

// Obs -> Event for one episode: seconds since the episode start, plus delay. Events outside
// [0, duration) are dropped. A fixed key order keeps the JSON byte-stable.
export function finalize(obs: Obs[], episodeId: string, startMs: number, duration = EPISODE_S): Event[] {
  const out: Event[] = [];
  for (const o of obs) {
    const occurred = Math.round((o.t_ms - startMs) / 1000);
    if (occurred < 0 || occurred >= duration) continue;
    const e: Event = {
      id: o.id,
      source_id: o.source_id,
      source_type: o.source_type,
      zone_id: o.zone_id,
      kind: o.kind,
      occurred_at: occurred,
      arrived_at: occurred + delayFor(episodeId, o.id, o.source_type),
    };
    if (o.gateway_id !== undefined) e.gateway_id = o.gateway_id;
    if (o.value !== undefined) e.value = o.value;
    if (o.reported_severity !== undefined) e.reported_severity = o.reported_severity;
    if (o.text !== undefined) e.text = o.text;
    out.push(e);
  }
  out.sort((a, b) => a.arrived_at - b.arrived_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
