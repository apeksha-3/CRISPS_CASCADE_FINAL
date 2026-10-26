// real/baselines.ts
// "What is normal here?" learned from the DRY CONTROL DAYS ONLY.
//
// Why only dry control days: the thing we want to detect (a flood cascade) is exactly what
// changes traffic, calls and hospital arrivals. If the cascade day were allowed into its own
// baseline, the baseline would partly contain the cascade and the cascade would look less
// unusual. Control days contain no cascade and no heavy rain, so they say what a normal day looks like.
//
// For a DRY episode, its own day is left out of the baseline (leave-one-day-out), so a dry
// episode is never judged against itself.
//
//   speed baseline : mean speed of each link for each hour of the day
//   ems baselines  : mean number of EMS calls (and hospital arrivals) per hour for each zone and hour of the day

import { loadJson } from "./load";
import { boardOfEmsCode, type RealZone, zoneIdOfBoard } from "./geo";
import { DOT_OK_STATUS, LINK_HEALTH, MIN_BASELINE_SAMPLES } from "./params";
import { localIsoToUtcMs } from "./tz";

export interface Baselines {
  days: string[]; // the dry days that built it
  speed: Map<string, { mean: number; n: number }>; // "linkId|hour"
  calls: Map<string, number>; // "zone|hour" -> expected calls per hour
  hospital: Map<string, number>; // "zone|hour" -> expected hospital arrivals per hour
}

export const hourOf = (localIso: string) => Number(localIso.slice(11, 13));

export function speedOf(row: Record<string, string>): number | undefined {
  if (row.status !== DOT_OK_STATUS) return undefined;
  const s = row.speed;
  if (s === undefined || s.trim() === "" || !/^-?\d+(\.\d+)?$/.test(s.trim())) return undefined;
  return Number(s);
}

export function buildBaselines(dryDays: string[], zones: Pick<RealZone, "zone_id">[], leaveOut?: string): Baselines {
  const days = dryDays.filter((d) => d !== leaveOut).sort();
  const zoneSet = new Set(zones.map((z) => z.zone_id));
  const sums = new Map<string, { sum: number; n: number }>();
  const calls = new Map<string, number>();
  const hospital = new Map<string, number>();
  for (const day of days) {
    for (const r of loadJson("dot-speeds", `dry-${day}`)) {
      const v = speedOf(r);
      if (v === undefined) continue;
      const key = `${r.link_id}|${hourOf(r.data_as_of)}`;
      const s = sums.get(key) ?? { sum: 0, n: 0 };
      s.sum += v;
      s.n++;
      sums.set(key, s);
    }
    for (const r of loadJson("ems", `dry-${day}`)) {
      const z = zoneIdOfBoard(boardOfEmsCode(r.communitydistrict));
      if (!z || !zoneSet.has(z)) continue;
      if (r.incident_datetime.slice(0, 10) === day) calls.set(`${z}|${hourOf(r.incident_datetime)}`, (calls.get(`${z}|${hourOf(r.incident_datetime)}`) ?? 0) + 1);
      const h = r.first_hosp_arrival_datetime;
      if (h && h.slice(0, 10) === day) hospital.set(`${z}|${hourOf(h)}`, (hospital.get(`${z}|${hourOf(h)}`) ?? 0) + 1);
    }
  }
  const n = days.length || 1;
  return {
    days,
    speed: new Map([...sums].map(([k, v]) => [k, { mean: v.sum / v.n, n: v.n }])),
    calls: new Map([...calls].map(([k, v]) => [k, v / n])),
    hospital: new Map([...hospital].map(([k, v]) => [k, v / n])),
  };
}

// Which links are healthy sources? Counted on the dry control days only (leave-one-day-out for a dry episode).
// Returns the link ids that sent >= LINK_HEALTH.min_valid valid reports on >= LINK_HEALTH.day_share of those days.
export function healthyLinks(dryDays: string[], leaveOut?: string): Set<string> {
  const days = dryDays.filter((d) => d !== leaveOut);
  const healthyDays = new Map<string, number>();
  for (const day of days) {
    const valid = new Map<string, number>();
    for (const r of loadJson("dot-speeds", `dry-${day}`)) if (speedOf(r) !== undefined) valid.set(r.link_id, (valid.get(r.link_id) ?? 0) + 1);
    for (const [link, n] of valid) if (n >= LINK_HEALTH.min_valid) healthyDays.set(link, (healthyDays.get(link) ?? 0) + 1);
  }
  const need = Math.ceil(LINK_HEALTH.day_share * days.length);
  return new Set([...healthyDays].filter(([, n]) => n >= need).map(([link]) => link));
}

export function baselineSpeed(b: Baselines, linkId: string, hour: number): number | undefined {
  const s = b.speed.get(`${linkId}|${hour}`);
  return s && s.n >= MIN_BASELINE_SAMPLES && s.mean > 0 ? s.mean : undefined;
}

// Used by tests and the plot: an instant (UTC ms) -> its local hour of day.
export { localIsoToUtcMs };
