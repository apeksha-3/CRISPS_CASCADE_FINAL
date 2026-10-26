// real/select.ts
// Pick the control days. Pure functions over IEM daily precipitation, so a test can feed fixtures.
// The rules are fixed in real/params.ts BEFORE any engine run on real data.
//
//   rain controls : weekday, KNYC daily total between 1.0 and 2.5 inches, no NWS flash flood
//                   EMERGENCY for New York City that day, not within 3 days of a cascade window,
//                   not next to another chosen rain day. Heaviest first, up to 8.
//   both          : the DOT speeds dataset must have at least 20,000 rows that day (it has whole missing days).
//   dry controls  : 10 target dates 36 days apart through 2022; for each, the nearest day (within
//                   15 days) with exactly 0 precipitation at KNYC, KJFK and KLGA, a dry day before it,
//                   Tuesday-Thursday, no holiday, not within 3 days of a cascade window.

import { CANDIDATE_BUFFER_DAYS, CASCADE_WINDOWS, DRY_CONTROL, HOLIDAYS, RAIN_CONTROL } from "./params";
import { addDays, weekday } from "./tz";

export type Daily = Record<string, { NYC?: number; JFK?: number; LGA?: number }>; // day -> inches ("T" trace = 0.001)

export function parseDaily(rows: Record<string, string>[]): Daily {
  const out: Daily = {};
  for (const r of rows) {
    const v = r.precip_in === "T" ? 0.001 : Number(r.precip_in);
    if (!Number.isFinite(v) || r.precip_in === "" || r.precip_in === "None") continue;
    (out[r.day] ??= {})[r.station as "NYC" | "JFK" | "LGA"] = v;
  }
  return out;
}

export function nearCascade(day: string): boolean {
  return CASCADE_WINDOWS.some((w) => day >= addDays(w.from, -CANDIDATE_BUFFER_DAYS) && day <= addDays(w.to, CANDIDATE_BUFFER_DAYS));
}

const isWeekday = (day: string) => weekday(day) >= 1 && weekday(day) <= 5;
const isMidweek = (day: string) => weekday(day) >= 2 && weekday(day) <= 4;
const ok = (day: string) => !HOLIDAYS.includes(day) && !nearCascade(day);

// A day is usable only if the DOT speeds dataset actually has data for it (it has gaps: some whole days are missing).
export const MIN_DOT_ROWS = 20_000;

// Rain candidates, heaviest first. The caller walks the list and drops days with a flash flood emergency.
export function rainCandidates(daily: Daily, hasTraffic: (day: string) => boolean = () => true): { day: string; in: number }[] {
  return Object.entries(daily)
    .filter(([day, d]) => d.NYC !== undefined && d.NYC >= RAIN_CONTROL.min_in && d.NYC <= RAIN_CONTROL.max_in && isWeekday(day) && ok(day) && hasTraffic(day))
    .map(([day, d]) => ({ day, in: d.NYC! }))
    .sort((a, b) => b.in - a.in || (a.day < b.day ? -1 : 1));
}

// Greedy pick of up to `count` days, no two on adjacent dates, skipping days `reject` refuses.
export function pickRain(cands: { day: string; in: number }[], reject: (day: string) => boolean, count = RAIN_CONTROL.count): string[] {
  const chosen: string[] = [];
  for (const c of cands) {
    if (chosen.length >= count) break;
    if (chosen.some((d) => Math.abs(Date.parse(d) - Date.parse(c.day)) <= 86_400_000)) continue;
    if (reject(c.day)) continue;
    chosen.push(c.day);
  }
  return chosen.sort();
}

const bone = (d: Daily[string] | undefined) => d !== undefined && d.NYC === 0 && d.JFK === 0 && d.LGA === 0;

export function pickDry(daily: Daily, taken: string[] = [], hasTraffic: (day: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (let k = 0; k < DRY_CONTROL.count; k++) {
    const target = addDays(DRY_CONTROL.first_target, k * DRY_CONTROL.step_days);
    for (let delta = 0; delta <= DRY_CONTROL.search_days; delta++) {
      const hit = [delta, -delta]
        .map((x) => addDays(target, x))
        .find((day) => bone(daily[day]) && bone(daily[addDays(day, -1)]) && isMidweek(day) && ok(day) && hasTraffic(day) && !out.includes(day) && !taken.includes(day));
      if (hit) {
        out.push(hit);
        break;
      }
    }
  }
  return out;
}
