// engine/grouping.ts
// Common-cause grouping, pipeline step 7, and the evidence-unit list (B3).
//
// B1. Gateway perfect-correlation detector.
//   Sensors behind one gateway share a failure point. If, in one tick, 5+ of a
//   gateway's sensors report the SAME value (rain gauges, drainage, traffic and
//   power meters all saying 99.9), no flood did that: the gateway is lying.
//   That whole group becomes ONE evidence unit that favors SENSOR_FAILURE
//   (config/likelihoods.ts GATEWAY_CORRELATED) instead of 25 "anomalies".
//   Stragglers (same gateway, same value, arriving a tick later) join the group
//   without adding weight.
//
// B2. Narrative clusters (rumor detector).
//   Citizen reports sharing a narrative_id are one story (engine/cluster.ts).
//   Corroborated = some PHYSICAL source (anything but citizens and the gateway
//   monitor) in the same zone reported a clear anomaly within +/-5 min.
//     corroborated   -> normal concave weight 1 + ln(n), normal citizen row
//     uncorroborated -> capped: worth ONE low-trust event, RUMOR_CAPPED row
//   Corroboration is sticky: once a sensor confirmed the story, it stays confirmed.
//
// B2b. Weather common cause.
//   Heavy rain makes drains overflow and roads slow down. Rain, drainage and
//   traffic signals in one zone are therefore NOT independent witnesses: they are
//   one weather event seen three ways, on a rain-only day just as much as in a
//   cascade. Per zone, the strong rain units and the drainage / traffic units that
//   came after it (chained) form one common-cause group of total
//   weight N, and the whole group is discounted like a cluster: worth 1 + ln(N),
//   so each unit's weight is multiplied by (1 + ln N) / N.
//   Calls, hospitals and power are NOT in the group: they are the downstream
//   human consequences that tell a cascade apart from a wet day.
//
// B3. Everything becomes an EvidenceUnit: singles, near-duplicate clusters,
//   gateway groups, narrative clusters. The filter scores units.

import { CLUSTER_KNOBS } from "../config/knobs";
import { TRUST_PRIORS } from "../config/trust-priors";
import { type Cluster, effectiveWeight, isSurge } from "./cluster";
import { isStrong } from "./order";
import { betaMean, geometricMean } from "./trust";
import type { CleanedEvent, Event, EvidenceUnit, PublicRegistry, Seconds } from "./types";

const NOT_EVIDENCE = new Set(["heartbeat", "retraction", "gateway_heartbeat_lost"]);

// How many registered sensors relay through each gateway.
export function gatewaySensorCounts(registry: PublicRegistry): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of registry.sources) if (s.gateway_id && s.source_type !== "gateway") m.set(s.gateway_id, (m.get(s.gateway_id) ?? 0) + 1);
  return m;
}

export interface GatewayFlag {
  gateway_id: string;
  value: number;
  unit_id: string;
  at: Seconds; // tick it was flagged
}

export interface GatewayGroup {
  gateway_id: string;
  value: number;
  ids: string[]; // member event ids, sorted
  joinId?: string; // stragglers: the earlier group's unit id
}

// B1: find groups of identical readings among this tick's fresh events.
export function detectGatewayGroups(
  fresh: Event[],
  sensorCounts: Map<string, number>,
  flags: GatewayFlag[],
  now: Seconds,
  k = CLUSTER_KNOBS,
): GatewayGroup[] {
  const byGw = new Map<string, Event[]>();
  for (const e of fresh) {
    if (!e.gateway_id || e.value === undefined || NOT_EVIDENCE.has(e.kind) || e.source_type === "gateway") continue;
    if ((sensorCounts.get(e.gateway_id) ?? 0) < k.gateway_min_sensors) continue;
    byGw.set(e.gateway_id, [...(byGw.get(e.gateway_id) ?? []), e]);
  }
  const out: GatewayGroup[] = [];
  for (const gw of [...byGw.keys()].sort()) {
    // bucket values: sorted, a new bucket starts when a value is more than epsilon above the bucket's first
    const evs = byGw.get(gw)!.slice().sort((a, b) => a.value! - b.value! || (a.id < b.id ? -1 : 1));
    const buckets: Event[][] = [];
    for (const e of evs) {
      const last = buckets.at(-1);
      if (last && e.value! - last[0].value! <= k.gateway_value_epsilon) last.push(e);
      else buckets.push([e]);
    }
    for (const b of buckets) {
      const value = b[0].value!;
      const ids = b.map((e) => e.id).sort();
      if (b.length >= k.gateway_min_events) {
        out.push({ gateway_id: gw, value, ids });
        continue;
      }
      // a straggler of a group flagged in the last few minutes?
      const prev = flags
        .filter((f) => f.gateway_id === gw && Math.abs(f.value - value) <= k.gateway_value_epsilon && now - f.at <= k.gateway_memory_s)
        .sort((a, b) => b.at - a.at)[0];
      if (prev) out.push({ gateway_id: gw, value, ids, joinId: prev.unit_id });
    }
  }
  return out;
}

// B2: is this narrative backed by a physical source in the same zone, +/- 5 min?
export function isCorroborated(c: Cluster, window: CleanedEvent[], ignore: { has(id: string): boolean }, k = CLUSTER_KNOBS): boolean {
  if (c.members.length === 0) return false;
  const lo = c.members.reduce((m, e) => Math.min(m, e.adjusted_occurred_at), Infinity) - k.corroboration_window_s;
  const hi = c.members.reduce((m, e) => Math.max(m, e.adjusted_occurred_at), -Infinity) + k.corroboration_window_s;
  return window.some(
    (e) =>
      e.source_type !== "citizen_report" &&
      !NOT_EVIDENCE.has(e.kind) &&
      e.source_type !== "gateway" &&
      !ignore.has(e.id) &&
      e.zone_id === c.zone_id &&
      (e.reported_severity ?? 1) >= k.corroboration_min_severity &&
      e.adjusted_occurred_at >= lo &&
      e.adjusted_occurred_at <= hi,
  );
}

// How much we trust one event's source (0..1). The engine passes the learned
// per-source trust (engine/trust.ts); the default is the starting guess for the type.
export type TrustLookup = (e: Event) => number;
export const typePriorTrust: TrustLookup = (e) => betaMean(TRUST_PRIORS[e.source_type]);
const zeroRow = () => ({ NOISE: 0, SENSOR_FAILURE: 0, ISOLATED_INCIDENT: 0, CASCADING_CRISIS: 0 });

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

// B3: a cluster as the filter sees it. hypothesis_contributions is filled by the filter.
// trust = geometric mean of the trust of its DISTINCT sources (engine/trust.ts).
export function toUnit(c: Cluster, k = CLUSTER_KNOBS, trustOf: TrustLookup = typePriorTrust): EvidenceUnit {
  const m = c.members;
  const n = m.length;
  let weight: number;
  if (c.type === "gateway_correlated") weight = n > 0 ? 1 : 0; // one lie = one unit
  else if (c.type === "narrative" && !c.corroborated) weight = n > 0 ? 1 : 0; // capped at one event
  else weight = effectiveWeight(c, k);
  const u: EvidenceUnit = {
    unit_id: c.id,
    unit_type: c.type === "near_duplicate" && n === 1 ? "single" : c.type,
    kind: c.kind,
    zone_id: c.zone_id,
    n,
    weight,
    strong: m.some((e) => isStrong(e)),
    chained: m.some((e) => e.chained),
    trust: n ? geometricMean([...new Map(m.map((e) => [e.source_id, trustOf(e)])).values()]) : 0,
    first_t: n ? Math.min(...m.map((e) => e.adjusted_occurred_at)) : c.anchor_t,
    last_t: n ? Math.max(...m.map((e) => e.adjusted_occurred_at)) : c.anchor_t,
    last_arrived_at: n ? Math.max(...m.map((e) => e.arrived_at)) : 0,
    hypothesis_contributions: zeroRow(),
    source_unit_ids: m.map((e) => e.id),
    sources: [...new Set(m.map((e) => e.source_id))].sort(),
  };
  const v = median(m.map((e) => e.value).filter((x): x is number => x !== undefined));
  if (v !== undefined) u.value = v;
  if (c.gateway_id) u.gateway_id = c.gateway_id;
  if (c.narrative_id) {
    u.narrative_id = c.narrative_id;
    u.corroborated = c.corroborated;
  }
  if (c.type === "near_duplicate" && isSurge(c, k)) u.surge = true;
  return u;
}

// One event on its own (tests, and a handy way to reuse Phase 2 style checks).
export function singleUnit(e: CleanedEvent): EvidenceUnit {
  return toUnit({ id: e.id, key: e.id, type: "near_duplicate", kind: e.kind, zone_id: e.zone_id, anchor_t: e.adjusted_occurred_at, members: [e], corroborated: false });
}

// B2b: discount the rain / drainage / traffic units of each zone as one weather event.
export function applyWeatherCommonCause(units: EvidenceUnit[], k = CLUSTER_KNOBS): void {
  if (!k.weather_common_cause) return;
  const groups = new Map<string, EvidenceUnit[]>();
  for (const u of units) {
    if (!WEATHER_KINDS.has(u.kind) || !u.strong || u.n === 0 || u.unit_type === "gateway_correlated") continue;
    if (u.kind !== "rain_heavy" && !u.chained) continue; // drainage / traffic with no rain before it is a local problem, not weather
    groups.set(u.zone_id, [...(groups.get(u.zone_id) ?? []), u]);
  }
  for (const us of groups.values()) {
    const total = us.reduce((s, u) => s + u.weight, 0);
    if (total <= 1) continue;
    const factor = (1 + Math.log(total)) / total;
    for (const u of us) {
      u.weight *= factor;
      u.common_cause = `weather in ${u.zone_id}: ${us.length} rain/drainage/traffic units worth ${(1 + Math.log(total)).toFixed(1)} together`;
    }
  }
}
const WEATHER_KINDS = new Set(["rain_heavy", "drainage_anomaly", "traffic_slowdown"]);
