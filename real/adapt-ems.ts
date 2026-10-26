// real/adapt-ems.ts
// FDNY EMS dispatch -> two feeds per zone (zone = the incident's community district).
//
//   dispatch (dsp-<zone>) : emergency_call_spike
//      Every 5 minutes, count the zone's incidents in the last 10 minutes. It is a spike when
//      n >= 4 and n > mean + 3 * sqrt(mean), where mean is what that zone sees in a 10-minute window
//      at that hour of the day on dry control days (Poisson: the spread of a count is about sqrt(mean)).
//      value = calls per 5 minutes (n / 2), the simulator's unit.
//      reported_severity = mean over those incidents of (9 - initial_severity_level_code) / 8
//      (EMS level 1 is the most severe, 8 the least).
//   hospital (hsp-<zone>) : hospital_arrivals_unusual
//      Same idea on first_hosp_arrival_datetime: count arrivals in the last 30 minutes,
//      spike when n >= 3 and n > mean + 3 * sqrt(mean) against the dry-day hospital baseline.
//      value = arrivals per hour (n * 2). reported_severity = 1 - mean / n, clipped (how much of the count is excess).
//      APPROXIMATION: the arrival is placed in the district of the INCIDENT, not of the hospital.
//   Rows whose district is missing or outside the 10 zones are counted, not used.

import { boardOfEmsCode, type RealZone, zoneIdOfBoard } from "./geo";
import { hourOf, type Baselines } from "./baselines";
import { EMS_CALLS, EMS_HOSPITAL, emsSeverity } from "./params";
import { type Obs, round1, round2, Unmapped } from "./obs";
import { localIsoToUtcMs, utcMsToLocalIso } from "./tz";

interface Item {
  t: number;
  sev?: number;
}

function slide(items: Item[], fromMs: number, toMs: number, cfg: { window_s: number; step_s: number }, fn: (n: number, mean: Item[], tMs: number) => void): void {
  const sorted = items.slice().sort((a, b) => a.t - b.t);
  for (let t = Math.ceil(fromMs / (cfg.step_s * 1000)) * cfg.step_s * 1000; t < toMs; t += cfg.step_s * 1000) {
    const inWin = sorted.filter((x) => x.t > t - cfg.window_s * 1000 && x.t <= t);
    fn(inWin.length, inWin, t);
  }
}

export function adaptEms(rows: Record<string, string>[], zones: RealZone[], base: Baselines, fromMs: number, toMs: number, unmapped: Unmapped): Obs[] {
  const known = new Set(zones.map((z) => z.zone_id));
  const calls = new Map<string, Item[]>();
  const arrivals = new Map<string, Item[]>();
  const push = (m: Map<string, Item[]>, z: string, it: Item) => m.set(z, [...(m.get(z) ?? []), it]);
  for (const r of rows) {
    const z = zoneIdOfBoard(boardOfEmsCode(r.communitydistrict));
    if (!z) {
      unmapped.add("ems: no usable community district");
      continue;
    }
    if (!known.has(z)) {
      unmapped.add("ems: district is not one of the 10 selected zones");
      continue;
    }
    const code = Number(r.initial_severity_level_code);
    push(calls, z, { t: localIsoToUtcMs(r.incident_datetime), sev: Number.isFinite(code) && r.initial_severity_level_code !== "" ? emsSeverity(code) : undefined });
    if (r.first_hosp_arrival_datetime) push(arrivals, z, { t: localIsoToUtcMs(r.first_hosp_arrival_datetime) });
  }

  const out: Obs[] = [];
  for (const z of [...known].sort()) {
    slide(calls.get(z) ?? [], fromMs, toMs, EMS_CALLS, (n, inWin, t) => {
      const mean = (base.calls.get(`${z}|${hourOf(utcMsToLocalIso(t))}`) ?? 0) * (EMS_CALLS.window_s / 3600);
      if (n < EMS_CALLS.min_count || n <= mean + EMS_CALLS.z * Math.sqrt(mean)) return;
      const sevs = inWin.map((x) => x.sev).filter((s): s is number => s !== undefined);
      const o: Obs = { id: `ems:calls:${z}:${t / 1000}`, source_id: `dsp-${z}`, source_type: "dispatch", zone_id: z, kind: "emergency_call_spike", t_ms: t, value: round1(n / (EMS_CALLS.window_s / 300)) };
      if (sevs.length) o.reported_severity = round2(sevs.reduce((a, b) => a + b, 0) / sevs.length);
      out.push(o);
    });
    slide(arrivals.get(z) ?? [], fromMs, toMs, EMS_HOSPITAL, (n, _w, t) => {
      const mean = (base.hospital.get(`${z}|${hourOf(utcMsToLocalIso(t))}`) ?? 0) * (EMS_HOSPITAL.window_s / 3600);
      if (n < EMS_HOSPITAL.min_count || n <= mean + EMS_HOSPITAL.z * Math.sqrt(mean)) return;
      out.push({ id: `ems:hosp:${z}:${t / 1000}`, source_id: `hsp-${z}`, source_type: "hospital", zone_id: z, kind: "hospital_arrivals_unusual", t_ms: t, value: round1(n * (3600 / EMS_HOSPITAL.window_s)), reported_severity: round2(Math.min(1, Math.max(0, 1 - mean / n))) });
    });
  }
  return out;
}
