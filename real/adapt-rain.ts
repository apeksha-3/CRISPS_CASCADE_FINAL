// real/adapt-rain.ts
// IEM ASOS 1-minute precipitation (inches per minute) -> rain_gauge events, one source per station.
//
//   The minutes are grouped into 5-minute reports (the report is stamped with the END of the bucket).
//   A bucket needs at least 3 valid minutes, else it is a missing report: no heartbeat (real silence).
//   A valid bucket is a heartbeat. If its rate is at least 7.6 mm/h (the NWS "heavy rain" line,
//   0.30 in/h) it is also a rain_heavy event:
//        value = mm per hour = inches per minute * 60 * 25.4 (using the valid minutes only)
//        reported_severity = mm/h / 50, clipped to [0, 1]
//   The IEM valid(UTC) column is UTC; it goes through the real timezone rules only when a local
//   time is needed (episode clocks use UTC instants, so no local conversion can drift).

import { INCH_MM, RAIN_BUCKET_S, RAIN_HEAVY_MM_H, RAIN_SEVERITY_FULL_MM_H } from "./params";
import { STATIONS } from "./registry";
import { type Obs, round1, round2, Unmapped } from "./obs";
import { utcStringToMs } from "./tz";

export function rainBuckets(rows: Record<string, string>[], station: string, fromMs: number, toMs: number): { t_ms: number; mmh: number; minutes: number }[] {
  const b = RAIN_BUCKET_S * 1000;
  const acc = new Map<number, { sum: number; n: number }>();
  for (const r of rows) {
    if (r.station !== station) continue;
    const t = utcStringToMs(r["valid(UTC)"]);
    const end = Math.ceil(t / b) * b; // the bucket (end-5min, end]
    if (end <= fromMs || end > toMs) continue;
    const p = r.precip;
    if (p === undefined || p === "" || p === "M" || !Number.isFinite(Number(p))) continue;
    const a = acc.get(end) ?? { sum: 0, n: 0 };
    a.sum += Number(p);
    a.n++;
    acc.set(end, a);
  }
  return [...acc.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([t, a]) => ({ t_ms: t, minutes: a.n, mmh: (a.sum / a.n) * 60 * INCH_MM }));
}

export function adaptRain(rows: Record<string, string>[], stationZone: Record<string, string>, gatewayOf: Map<string, string>, fromMs: number, toMs: number, unmapped: Unmapped): Obs[] {
  const out: Obs[] = [];
  for (const [station, s] of Object.entries(STATIONS)) {
    const zone = stationZone[station];
    for (const bk of rainBuckets(rows, station, fromMs, toMs)) {
      if (bk.minutes < 3) {
        unmapped.add("rain: 5-minute bucket with fewer than 3 valid minutes: missing report");
        continue;
      }
      const base = { source_id: s.id, source_type: "rain_gauge" as const, gateway_id: gatewayOf.get(zone), zone_id: zone, t_ms: bk.t_ms };
      out.push({ ...base, id: `rain:hb:${s.id}:${bk.t_ms / 1000}`, kind: "heartbeat" });
      if (bk.mmh >= RAIN_HEAVY_MM_H) out.push({ ...base, id: `rain:${s.id}:${bk.t_ms / 1000}`, kind: "rain_heavy", value: round1(bk.mmh), reported_severity: round2(Math.min(1, bk.mmh / RAIN_SEVERITY_FULL_MM_H)) });
    }
  }
  return out;
}
