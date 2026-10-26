// scripts/real/lags.ts
// Phase 8 step D. Timescale diagnostic: in the real events, how long after the heavy rain starts does each stage rise?
// A table only. Nothing is changed and nothing is tuned.
//
// Per event, on its local day:
//   rain onset  = first 5-minute rate >= 25 mm/h (max of the 3 stations) within 2 hours before to 1 hour after the start
//                 of the heaviest 60 minutes of rain. A second anchor, the first 5-minute rate >= 50 mm/h, is also reported:
//                 the stages answer the intense burst, not the first heavy drops
//   a stage RISES = its trailing 30-minute count is >= 3 standard deviations above the mean of the same clock time on the
//                 10 dry control days (sd floored at 1), AND at least 1.25 times that mean, AND at least 5 events, in 2 consecutive
//                 5-minute bins; the first such bin is the rise (the count and ratio floors stop a handful of reports counting)
//   lag = rise time - rain onset, in minutes (negative = the stage rose BEFORE the heavy rain)
// Stages: 311 flood + drainage reports (citywide), traffic slowdowns (registered links, 10 zones, as the engine sees them),
// EMS calls (citywide), hospital arrivals (citywide, first_hosp_arrival).
// Compared with the engine's config lags (config/lags.ts, in minutes from rain): drainage 2.8, traffic 4.7, calls 6.6, hospital 9.1.
//
// Run: npx tsx scripts/real/lags.ts

import { writeFileSync } from "node:fs";
import { rainBuckets } from "../../real/adapt-rain";
import { map311 } from "../../real/adapt-311";
import { buildBaselines, healthyLinks } from "../../real/baselines";
import { loadContext, observe } from "../../real/context";
import { heaviestRain, loadLabels, loadLabels8 } from "../../real/episodes";
import { loadIem, loadJson } from "../../real/load";
import { Unmapped } from "../../real/obs";
import { LEARNED_LAGS } from "../../config/lags";
import { addDays, localIsoToUtcMs, utcMsToLocalIso } from "../../real/tz";

const ctx = loadContext();
const dry = ctx.controls.dry;
const BIN = 300_000;
const BINS = 288;
const WIN = 6;
const STAGES = ["311 flood+drainage", "traffic slowdowns", "EMS calls", "hospital arrivals"] as const;

// 288 five-minute bin counts for each stage on one local day
function daySeries(windowId: string, day: string, healthy: Set<string>, leaveOut?: string): number[][] {
  const from = localIsoToUtcMs(`${day}T00:00:00`);
  const to = localIsoToUtcMs(`${addDays(day, 1)}T00:00:00`);
  const bin = (t: number) => Math.floor((t - from) / BIN);
  const out = STAGES.map(() => Array<number>(BINS).fill(0));
  for (const r of loadJson("311", windowId)) {
    const m = map311(r.complaint_type ?? "", r.descriptor ?? "");
    if (!m || m.kind === "power_comms_load") continue;
    const t = localIsoToUtcMs(r.created_date);
    if (t >= from && t < to) out[0][bin(t)]++;
  }
  const base = buildBaselines(dry, ctx.zones, leaveOut);
  for (const o of observe(ctx, windowId, from, to, base, new Unmapped(), healthy)) if (o.kind === "traffic_slowdown" && o.source_id.startsWith("trf-")) out[1][bin(o.t_ms)]++;
  for (const r of loadJson("ems", windowId)) {
    const t = localIsoToUtcMs(r.incident_datetime);
    if (t >= from && t < to) out[2][bin(t)]++;
    if (r.first_hosp_arrival_datetime) {
      const h = localIsoToUtcMs(r.first_hosp_arrival_datetime);
      if (h >= from && h < to) out[3][bin(h)]++;
    }
  }
  return out;
}
const trailing = (c: number[]) => c.map((_, i) => (i < WIN - 1 ? NaN : c.slice(i - WIN + 1, i + 1).reduce((a, b) => a + b, 0)));

const dryHealthy = new Map(dry.map((d) => [d, healthyLinks(dry, d)]));
const dryTrail = dry.map((d) => daySeries(`dry-${d}`, d, dryHealthy.get(d)!, d).map(trailing));
const allHealthy = healthyLinks(dry);

interface Ev { id: string; tier: string; window: string }
const l7 = loadLabels();
const l8 = loadLabels8();
const events: Ev[] = [
  ...l7.cascades.map((c) => ({ id: c.event_id, tier: "cascade", window: c.window })),
  ...l8.events.map((e) => ({ id: e.event_id, tier: e.tier, window: e.window })),
];

interface Row { id: string; tier: string; onset: string; onset50: string; lags: (number | undefined)[]; lags50: (number | undefined)[]; peakRatio: number[] }
const rows: Row[] = [];
for (const ev of events) {
  const peak = heaviestRain(loadIem(ev.window), 60);
  const day = utcMsToLocalIso(peak).slice(0, 10);
  const dayStart = localIsoToUtcMs(`${day}T00:00:00`);
  // rain onset
  const all: { t: number; mmh: number }[] = [];
  for (const st of ["NYC", "JFK", "LGA"]) for (const b of rainBuckets(loadIem(ev.window), st, peak - 2 * 3600_000, peak + 3600_000)) if (b.minutes >= 3) all.push({ t: b.t_ms, mmh: b.mmh });
  const first = (thr: number) => all.filter((a) => a.mmh >= thr).sort((a, b) => a.t - b.t)[0];
  const onsetBucket = first(25);
  if (!onsetBucket) continue;
  const onsetT = onsetBucket.t - BIN; // the bucket covers the 5 minutes before its stamp
  const b50 = first(50);
  const onset50T = b50 ? b50.t - BIN : undefined;
  const series = daySeries(ev.window, day, allHealthy).map(trailing);
  const lo = Math.max(WIN, Math.floor((onsetT - 3 * 3600_000 - dayStart) / BIN));
  const hi = Math.min(BINS - 2, Math.floor((onsetT + 6 * 3600_000 - dayStart) / BIN));
  const lags: (number | undefined)[] = [];
  const lags50: (number | undefined)[] = [];
  const ratio: number[] = [];
  STAGES.forEach((_, s) => {
    const z = (i: number) => {
      const m = dryTrail.reduce((a, x) => a + x[s][i], 0) / dryTrail.length;
      const sd = Math.sqrt(dryTrail.reduce((a, x) => a + (x[s][i] - m) ** 2, 0) / (dryTrail.length - 1));
      return (series[s][i] - m) / Math.max(sd, 1);
    };
    let rise: number | undefined;
    const m = (i: number) => dryTrail.reduce((a, x) => a + x[s][i], 0) / dryTrail.length;
    const up = (i: number) => z(i) >= 3 && series[s][i] >= 1.25 * m(i) && series[s][i] >= 5;
    for (let i = lo; i <= hi && rise === undefined; i++) if (up(i) && up(i + 1)) rise = i;
    lags.push(rise === undefined ? undefined : Math.round(((dayStart + rise * BIN) - onsetT) / 60_000));
    lags50.push(rise === undefined || onset50T === undefined ? undefined : Math.round(((dayStart + rise * BIN) - onset50T) / 60_000));
    ratio.push(Math.max(...Array.from({ length: hi - lo + 1 }, (_, k) => series[s][lo + k] / Math.max(1, dryTrail.reduce((a, x) => a + x[s][lo + k], 0) / dryTrail.length))));
  });
  rows.push({ id: ev.id, tier: ev.tier, onset: utcMsToLocalIso(onsetT).replace("T", " ").slice(0, 16), onset50: onset50T === undefined ? "none" : utcMsToLocalIso(onset50T).replace("T", " ").slice(0, 16), lags, lags50, peakRatio: ratio });
}

const cell = (v: number | undefined) => (v === undefined ? "no rise" : `${v >= 0 ? "+" : ""}${v}`).padStart(19);
const stat = (xs: number[]) => (xs.length ? { n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length } : undefined);
const sdOf = (xs: number[]) => (xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - xs.reduce((c, d) => c + d, 0) / xs.length) ** 2, 0) / (xs.length - 1)) : NaN);
const L = LEARNED_LAGS;
// the engine's chain order is drainage, traffic, calls, hospital; the table order is 311, traffic, calls, hospital
const cum = [L.drainage_anomaly!.mean / 60, (L.drainage_anomaly!.mean + L.traffic_slowdown!.mean) / 60, (L.drainage_anomaly!.mean + L.traffic_slowdown!.mean + L.emergency_call_spike!.mean) / 60, (L.drainage_anomaly!.mean + L.traffic_slowdown!.mean + L.emergency_call_spike!.mean + L.hospital_arrivals_unusual!.mean) / 60];
for (const [title, key, onsetKey] of [["from the first 5-minute rate >= 25 mm/h", "lags", "onset"], ["from the first 5-minute rate >= 50 mm/h", "lags50", "onset50"]] as const) {
  console.log(`\nMinutes ${title} to the first rise of each stage`);
  console.log(`${"event".padEnd(18)} ${"tier".padEnd(10)} ${"rain anchor (local)".padEnd(17)} ${STAGES.map((s) => s.padStart(19)).join("")}   peak ratio to normal (311/traffic/calls/hosp)`);
  for (const r of rows) console.log(`${r.id.padEnd(18)} ${r.tier.padEnd(10)} ${r[onsetKey].padEnd(17)} ${r[key].map(cell).join("")}   ${r.peakRatio.map((x) => x.toFixed(1)).join(" / ")}`);
  console.log("Summary over the events where the stage rose");
  console.log(`${"stage".padEnd(20)} ${"engine config (min)".padEnd(20)} ${"cascade tier: n/events, mean, sd".padEnd(34)} all events: n/events, mean, sd`);
  STAGES.forEach((s, k) => {
    const f = (rs: Row[]) => {
      const xs = rs.map((r) => r[key][k]).filter((x): x is number => x !== undefined);
      const st = stat(xs);
      return st ? `${st.n}/${rs.length}, ${st.mean.toFixed(0)}, ${Number.isFinite(sdOf(xs)) ? sdOf(xs).toFixed(0) : "-"}` : `0/${rs.length}, -, -`;
    };
    console.log(`${s.padEnd(20)} ${cum[k].toFixed(1).padEnd(20)} ${f(rows.filter((r) => r.tier === "cascade")).padEnd(34)} ${f(rows)}`);
  });
}
writeFileSync("data/real/lags.json", JSON.stringify({ stages: STAGES, engine_config_min: cum, rows }, null, 1));
