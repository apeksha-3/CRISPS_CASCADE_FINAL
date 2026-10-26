// real/adapt-dot.ts
// DOT traffic speeds -> traffic_sensor events, one source per link (trf-<link>).
//
//   Every VALID report becomes a heartbeat (the link is alive). A report whose status is not 0
//   (-101: "no valid reading") is real silence: no heartbeat, and it is counted.
//   A valid report below SLOWDOWN_FRACTION (60%) of the link's own baseline speed for that
//   hour of the day also becomes a traffic_slowdown:
//        reported_severity = 1 - speed / baseline, clipped to [0, 1]
//        value             = the same drop in percent (the simulator's unit for traffic_slowdown)
//   The baseline comes from dry control days only (real/baselines.ts).
//   Event ids are link + timestamp. (The DOT `id` column is NOT unique per report: it repeats for each link,
//   and using it made the engine's log drop most heartbeats as duplicates. A test now checks ids are unique.)
//   Rows with a non-numeric speed are rejected and counted.
//   A link with no zone (more than 6 km from every centroid) is not a registered source: counted.

import { baselineSpeed, type Baselines, hourOf, speedOf } from "./baselines";
import { localIsoToUtcMs } from "./tz";
import { type Obs, round1, round2, Unmapped } from "./obs";
import { SLOWDOWN_FRACTION } from "./params";

export function adaptDot(
  rows: Record<string, string>[],
  linkZone: Map<string, string>,
  gatewayOf: Map<string, string>, // zone -> gateway
  base: Baselines,
  fromMs: number,
  toMs: number,
  unmapped: Unmapped,
  healthy?: Set<string>, // Phase 8: links that are real sources; others are not registered
): Obs[] {
  const out: Obs[] = [];
  for (const r of rows) {
    const t = localIsoToUtcMs(r.data_as_of);
    if (t < fromMs || t >= toMs) continue;
    const zone = linkZone.get(r.link_id);
    if (!zone) {
      unmapped.add("dot: link has no zone (no coordinates, or more than 6 km from every zone centroid)");
      continue;
    }
    if (healthy && !healthy.has(r.link_id)) {
      unmapped.add("dot: link not registered (it did not report on enough dry control days)");
      continue;
    }
    const speed = speedOf(r);
    if (speed === undefined) {
      const bad = r.status !== "0" ? "dot: status is not 0 (sensor sent no valid reading): silence" : "dot: non-numeric speed";
      unmapped.add(bad);
      continue;
    }
    const source = {
      source_id: `trf-${r.link_id}`,
      source_type: "traffic_sensor" as const,
      gateway_id: gatewayOf.get(zone),
      zone_id: zone,
      t_ms: t,
    };
    out.push({ ...source, id: `dot:hb:${r.link_id}:${r.data_as_of}`, kind: "heartbeat" });
    const b = baselineSpeed(base, r.link_id, hourOf(r.data_as_of));
    if (b === undefined) {
      unmapped.add("dot: no dry-day baseline for this link and hour (fewer than 8 samples): reported, not scored");
      continue;
    }
    if (speed < SLOWDOWN_FRACTION * b) {
      const drop = Math.min(1, Math.max(0, 1 - speed / b));
      out.push({ ...source, id: `dot:slow:${r.link_id}:${r.data_as_of}`, kind: "traffic_slowdown", value: round1(100 * drop), reported_severity: round2(drop) });
    }
  }
  return out;
}
