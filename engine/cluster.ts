// engine/cluster.ts
// Near-duplicate clustering (R10), pipeline step 6.
//
// Many events are about ONE real-world incident: three drainage sensors on one
// street, a dispatcher logging the same crash twice, fifty citizens posting the
// same story. Counting each as independent evidence makes the engine wildly
// overconfident. So we group them:
//
//   near-duplicate  same zone + same kind + same severity class (strong/weak),
//                   occurred within 3 min of an event already in the cluster.
//                   A stage that keeps going (drainage in one zone for 20 min,
//                   all from the same rain) stays ONE cluster: one weather event,
//                   one growing unit, instead of a fresh unit every 3 minutes.
//   narrative       citizen reports sharing a narrative_id (one story)
//   gateway         identical readings from one gateway (flagged by engine/grouping.ts)
//
// Concave discount: a cluster of n events is worth  weight = 1 + ln(n)  events.
//   n = 1 -> 1,  n = 5 -> 2.6,  n = 50 -> 4.9   (not 50!)
// Each extra copy adds less than the one before (the slope of ln n is 1/n).
//
// Surge protection: a REAL surge has many distinct incidents. If a cluster reaches
// 30 events AND their values are spread out (standard deviation above a
// threshold: copies of one report have identical values, different incidents
// do not), we stop discounting: weight = n.
//
// Retraction: removing a member recomputes the weight with n - 1. A cluster with
// n = 0 is gone; the filter subtracts its whole contribution (engine/tick.ts).
//
// The book is kept across ticks (clusters outlive the 15-min window, so a late
// retraction can still find its cluster). Deterministic: ids are a counter.

import { CLUSTER_KNOBS } from "../config/knobs";
import { isStrong } from "./order";
import type { CleanedEvent, Seconds, UnitType } from "./types";

export interface Cluster {
  id: string;
  key: string; // "z03|drainage_anomaly|strong", "narr|n-1a2b", "gw|gw0|99.9"
  type: Exclude<UnitType, "single">; // a near_duplicate cluster with one member is reported as "single"
  kind: CleanedEvent["kind"];
  zone_id: string;
  anchor_t: Seconds; // adjusted time of the first member (picks the nearest cluster when several match)
  members: CleanedEvent[];
  narrative_id?: string;
  gateway_id?: string;
  corroborated: boolean; // narrative only; sticky once true
}

export type ClusterKnobs = typeof CLUSTER_KNOBS;

// The concave discount. ln is the natural log.
export function clusterWeight(n: number): number {
  return n <= 0 ? 0 : 1 + Math.log(n);
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
}

// "Too many, too different to be one incident": a genuine surge (E3).
export function isSurge(c: Cluster, k: ClusterKnobs = CLUSTER_KNOBS): boolean {
  if (c.type !== "near_duplicate" || c.members.length < k.surge_min_events) return false;
  const values = c.members.map((m) => m.value).filter((v): v is number => v !== undefined);
  return values.length >= c.members.length / 2 && sd(values) > k.surge_value_sd;
}

export function effectiveWeight(c: Cluster, k: ClusterKnobs = CLUSTER_KNOBS): number {
  return isSurge(c, k) ? c.members.length : clusterWeight(c.members.length);
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class ClusterBook {
  private clusters = new Map<string, Cluster>();
  private byKey = new Map<string, string[]>(); // key -> cluster ids
  private byEvent = new Map<string, string>(); // event id -> cluster id
  private counter = 0;

  constructor(private knobs: ClusterKnobs = CLUSTER_KNOBS) {}

  // Put one fresh event into its cluster (joining an existing one if it matches).
  add(e: CleanedEvent): Cluster {
    if (e.kind === "citizen_report" && e.narrative_id) {
      return this.join(`narr|${e.narrative_id}`, "narrative", e, () => true, { narrative_id: e.narrative_id });
    }
    const key = `${e.zone_id}|${e.kind}|${isStrong(e) ? "strong" : "weak"}`;
    const w = this.knobs.near_dup_window_s;
    const fits = (c: Cluster) => c.members.some((m) => Math.abs(e.adjusted_occurred_at - m.adjusted_occurred_at) <= w);
    return this.join(key, "near_duplicate", e, fits, {});
  }

  // A gateway group (engine/grouping.ts decided these events are one lie).
  addGatewayGroup(gateway_id: string, value: number, events: CleanedEvent[], joinId?: string): Cluster {
    const existing = joinId ? this.clusters.get(joinId) : undefined;
    if (existing) {
      for (const e of events) this.attach(existing, e);
      return existing;
    }
    const first = events[0];
    const c = this.create(`gw|${gateway_id}|${value}`, "gateway_correlated", first, { gateway_id });
    for (const e of events.slice(1)) this.attach(c, e);
    return c;
  }

  private join(key: string, type: Cluster["type"], e: CleanedEvent, fits: (c: Cluster) => boolean, extra: Partial<Cluster>): Cluster {
    // the matching cluster with the nearest anchor (ties: the older cluster)
    let best: Cluster | undefined;
    for (const id of this.byKey.get(key) ?? []) {
      const c = this.clusters.get(id)!;
      if (c.members.length === 0 || !fits(c)) continue;
      if (!best || Math.abs(e.adjusted_occurred_at - c.anchor_t) < Math.abs(e.adjusted_occurred_at - best.anchor_t)) best = c;
    }
    if (best) {
      this.attach(best, e);
      return best;
    }
    return this.create(key, type, e, extra);
  }

  private create(key: string, type: Cluster["type"], e: CleanedEvent, extra: Partial<Cluster>): Cluster {
    const c: Cluster = { id: `u${++this.counter}`, key, type, kind: e.kind, zone_id: e.zone_id, anchor_t: e.adjusted_occurred_at, members: [], corroborated: false, ...extra };
    this.clusters.set(c.id, c);
    this.byKey.set(key, [...(this.byKey.get(key) ?? []), c.id]);
    this.attach(c, e);
    return c;
  }

  private attach(c: Cluster, e: CleanedEvent): void {
    c.members.push(e);
    c.members.sort(byId); // order-independent: same members => same cluster state
    this.byEvent.set(e.id, c.id);
  }

  // A member was retracted: n drops by one. Returns the cluster it was in.
  retract(eventId: string): Cluster | undefined {
    const id = this.byEvent.get(eventId);
    if (!id) return undefined;
    const c = this.clusters.get(id)!;
    c.members = c.members.filter((m) => m.id !== eventId);
    this.byEvent.delete(eventId);
    return c;
  }

  // Forget a cluster whose last member was retracted (after its contribution was subtracted).
  drop(id: string): void {
    const c = this.clusters.get(id);
    if (!c) return;
    this.clusters.delete(id);
    this.byKey.set(c.key, (this.byKey.get(c.key) ?? []).filter((x) => x !== id));
  }

  has(eventId: string): boolean {
    return this.byEvent.has(eventId);
  }

  clusterOf(eventId: string): Cluster | undefined {
    const id = this.byEvent.get(eventId);
    return id ? this.clusters.get(id) : undefined;
  }

  get(id: string): Cluster | undefined {
    return this.clusters.get(id);
  }

  all(): Cluster[] {
    return [...this.clusters.values()];
  }

  // A copy that can be changed without touching this one (the tick commits it only on success).
  clone(): ClusterBook {
    const b = new ClusterBook(this.knobs);
    for (const [id, c] of this.clusters) b.clusters.set(id, { ...c, members: c.members.slice() });
    for (const [k, v] of this.byKey) b.byKey.set(k, v.slice());
    b.byEvent = new Map(this.byEvent);
    b.counter = this.counter;
    return b;
  }
}

// Convenience for tests: cluster a batch of events from scratch.
export function clusterEvents(events: CleanedEvent[], knobs: ClusterKnobs = CLUSTER_KNOBS): Cluster[] {
  const book = new ClusterBook(knobs);
  for (const e of events) book.add(e);
  return book.all();
}
