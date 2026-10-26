// real/adapt-collisions.ts
// NYPD motor vehicle collisions -> isolated-incident evidence.
// In the simulator an isolated incident looks like ONE road slowing down in ONE zone, with no
// upstream flooding ("accident" variant). A crash is the same story, so each crash becomes one
// traffic_slowdown event from a per-zone log source (col-<zone>), placed by its latitude / longitude
// in the nearest zone centroid (within 6 km). Crashes without coordinates are counted.
// reported_severity is an ASSUMPTION, not data: no injury 0.3, injury 0.6, death 0.9 (real/params.ts).

import { nearestZone, type RealZone } from "./geo";
import { COLLISION_SEVERITY } from "./params";
import { type Obs, Unmapped } from "./obs";
import { localIsoToUtcMs } from "./tz";

export function adaptCollisions(rows: Record<string, string>[], zones: RealZone[], fromMs: number, toMs: number, unmapped: Unmapped): Obs[] {
  const out: Obs[] = [];
  for (const r of rows) {
    const m = (r.crash_time ?? "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) {
      unmapped.add("collisions: crash_time missing or malformed");
      continue;
    }
    const t = localIsoToUtcMs(`${r.crash_date.slice(0, 10)}T${m[1].padStart(2, "0")}:${m[2]}:00`);
    if (t < fromMs || t >= toMs) continue;
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    if (!r.latitude || !r.longitude || !Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0 || lon === 0) {
      unmapped.add("collisions: no coordinates");
      continue;
    }
    const zone = nearestZone(zones, lat, lon);
    if (!zone) {
      unmapped.add("collisions: more than 6 km from every zone centroid");
      continue;
    }
    const killed = Number(r.number_of_persons_killed) > 0;
    const injured = Number(r.number_of_persons_injured) > 0;
    out.push({
      id: `col:${r.collision_id}`,
      source_id: `col-${zone}`,
      source_type: "traffic_sensor",
      zone_id: zone,
      kind: "traffic_slowdown",
      t_ms: t,
      reported_severity: killed ? COLLISION_SEVERITY.killed : injured ? COLLISION_SEVERITY.injured : COLLISION_SEVERITY.none,
      text: "collision report",
    });
  }
  return out;
}
