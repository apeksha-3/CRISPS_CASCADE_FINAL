// scripts/real/crosscheck.ts
// NOAA ISD hourly is used ONLY as a cross-check of the IEM 1-minute rain (the adapters never read it).
// ISD hourly METAR reports (FM-15, at about :51 UTC) carry AA1 = "period_hours,depth_tenths_mm,condition,quality".
// For each report with a 1-hour period we compare its depth with the IEM 1-minute total over the same hour.
// Run: npx tsx scripts/real/crosscheck.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadIem } from "../../real/load";
import { RAW_DIR } from "../../real/net";
import { utcStringToMs } from "../../real/tz";

const ISD: Record<string, string> = { "72505394728": "NYC", "74486094789": "JFK", "72503014732": "LGA" };
const INCH_MM = 25.4;

for (const w of ["ida-2021", "flood-2023"]) {
  const isd = JSON.parse(readFileSync(join(RAW_DIR, `isd-hourly__${w}.json`), "utf8")) as Record<string, string>[];
  const iem = loadIem(w);
  console.log(`\n${w}`);
  console.log("station  hourly reports  ISD total mm  IEM total mm  ratio  correlation  largest hourly gap mm");
  for (const [id, st] of Object.entries(ISD)) {
    const minutes = new Map<number, number>();
    for (const r of iem) if (r.station === st && Number.isFinite(Number(r.precip)) && r.precip !== "") minutes.set(utcStringToMs(r["valid(UTC)"]), Number(r.precip) * INCH_MM);
    const a: number[] = [];
    const b: number[] = [];
    for (const r of isd) {
      if (r.STATION !== id || r.REPORT_TYPE?.trim() !== "FM-15" || !r.AA1) continue;
      const [hours, depth, , q] = r.AA1.split(",");
      if (hours !== "01" || depth === "9999" || !["1", "5", "9"].includes(q)) continue;
      const t = utcStringToMs(r.DATE);
      let sum = 0;
      let n = 0;
      for (let k = 0; k < 60; k++) {
        const v = minutes.get(t - k * 60_000);
        if (v !== undefined) {
          sum += v;
          n++;
        }
      }
      if (n < 50) continue; // IEM has gaps: only compare hours that are almost complete
      a.push(Number(depth) / 10);
      b.push(sum);
    }
    const tot = (x: number[]) => x.reduce((s, v) => s + v, 0);
    const ma = tot(a) / a.length;
    const mb = tot(b) / b.length;
    const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
    const corr = cov / Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0) * b.reduce((s, v) => s + (v - mb) ** 2, 0));
    console.log(`${st.padEnd(8)} ${String(a.length).padStart(14)} ${tot(a).toFixed(1).padStart(13)} ${tot(b).toFixed(1).padStart(13)} ${(tot(b) / tot(a)).toFixed(2).padStart(6)} ${corr.toFixed(3).padStart(12)} ${Math.max(...a.map((v, i) => Math.abs(v - b[i]))).toFixed(1).padStart(22)}`);
  }
}
