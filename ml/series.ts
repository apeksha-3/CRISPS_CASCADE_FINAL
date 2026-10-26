// ml/series.ts
// Phase 9: turn the cached raw files into aligned 5-minute series (rain, 311) and hourly DOT arrays.
// All indexes count 5-minute buckets from BASE (2019-01-01 00:00 UTC). Bucket i is the interval (BASE + (i-1)*5min, BASE + i*5min],
// "stamped" with its end, exactly as in real/adapt-rain.ts. A tick at bucket i knows everything up to the end of bucket i.
// Nothing here looks at an outcome.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { map311 } from "../real/adapt-311";
import { RAW_DIR } from "../real/net";
import { INCH_MM } from "../real/params";
import { addDays, localIsoToUtcMs, utcMsToLocalIso } from "../real/tz";

export const BUCKET_MS = 300_000;
export const BASE_MS = Date.UTC(2019, 0, 1, 0, 0, 0);
export const START_DAY = "2019-01-01";
export const END_DAY = "2026-10-20"; // inclusive, the same fixed end as scripts/real/fetch9.ts
export const STATIONS = ["NYC", "JFK", "LGA"] as const;

export const endMs = () => localIsoToUtcMs(`${addDays(END_DAY, 1)}T00:00:00`);
export const nBuckets = () => Math.ceil((endMs() - BASE_MS) / BUCKET_MS) + 1;
export const bucketOf = (ms: number) => Math.ceil((ms - BASE_MS) / BUCKET_MS);
export const msOfBucket = (i: number) => BASE_MS + i * BUCKET_MS;

export function months(): string[] {
  const out: string[] = [];
  for (let y = 2019, m = 1; ; ) {
    const id = `${y}-${String(m).padStart(2, "0")}`;
    if (`${id}-01` > END_DAY) break;
    out.push(id);
    if (m === 12) { y++; m = 1; } else m++;
  }
  return out;
}

const read = (f: string) => {
  const p = join(RAW_DIR, f);
  if (!existsSync(p)) throw new Error(`missing ${p}. Run: npx tsx scripts/real/fetch9.ts`);
  return readFileSync(p, "utf8");
};

// ---------- rain: per station, mm per hour for each 5-minute bucket (NaN = fewer than 3 valid minutes) ----------
export interface Rain {
  rate: Float32Array[]; // [station][bucket] mm/h
}

export function loadRain(): Rain {
  const n = nBuckets();
  const sum = STATIONS.map(() => new Float64Array(n));
  const cnt = STATIONS.map(() => new Uint8Array(n));
  for (const m of months()) {
    const text = read(`iem9__${m}.csv`);
    let pos = text.indexOf("\n") + 1;
    while (pos > 0 && pos < text.length) {
      let nl = text.indexOf("\n", pos);
      if (nl < 0) nl = text.length;
      const line = text.slice(pos, nl);
      pos = nl + 1;
      const c = line.split(",");
      if (c.length < 4) continue;
      const si = STATIONS.indexOf(c[0] as (typeof STATIONS)[number]);
      if (si < 0) continue;
      const p = c[3];
      if (p === "" || p === "M") continue;
      const v = Number(p);
      if (!Number.isFinite(v)) continue;
      // "2021-09-02 01:28" is UTC
      const t = Date.UTC(+c[2].slice(0, 4), +c[2].slice(5, 7) - 1, +c[2].slice(8, 10), +c[2].slice(11, 13), +c[2].slice(14, 16));
      const b = bucketOf(t);
      if (b < 0 || b >= n) continue;
      sum[si][b] += v;
      cnt[si][b]++;
    }
  }
  const rate = STATIONS.map((_, s) => {
    const r = new Float32Array(n).fill(NaN);
    for (let b = 0; b < n; b++) if (cnt[s][b] >= 3) r[b] = (sum[s][b] / cnt[s][b]) * 60 * INCH_MM;
    return r;
  });
  return { rate };
}

// ---------- 311: citywide flood and drainage reports per 5-minute bucket ----------
export function load311(): Int32Array {
  const out = new Int32Array(nBuckets());
  for (let y = 2019; y <= 2026; y++) {
    const rows = JSON.parse(read(`f311__${y}.json`)) as { created_date: string; complaint_type: string; descriptor: string }[];
    for (const r of rows) {
      const m = map311(r.complaint_type ?? "", r.descriptor ?? "");
      if (!m || m.kind === "power_comms_load") continue; // flood and drainage only (both category schemes are understood by map311)
      const b = bucketOf(localIsoToUtcMs(r.created_date));
      if (b >= 0 && b < out.length) out[b]++;
    }
  }
  return out;
}

// ---------- local calendar ----------
export interface Calendar {
  days: string[]; // "YYYY-MM-DD" from START_DAY to END_DAY
  dayOfBucket: Int32Array; // bucket -> index into days
  hourOfBucket: Uint8Array; // bucket -> local clock hour (of the bucket's END)
  minuteOfBucket: Uint8Array;
  dayStartBucket: Int32Array; // first bucket whose end is after local midnight
  weekend: boolean[];
}

export function loadCalendar(): Calendar {
  const days: string[] = [];
  for (let d = START_DAY; d <= END_DAY; d = addDays(d, 1)) days.push(d);
  const n = nBuckets();
  const dayOfBucket = new Int32Array(n);
  const hourOfBucket = new Uint8Array(n);
  const minuteOfBucket = new Uint8Array(n);
  const dayStartBucket = new Int32Array(days.length + 1);
  const starts = days.map((d) => localIsoToUtcMs(`${d}T00:00:00`));
  let di = 0;
  for (let b = 0; b < n; b++) {
    const t = msOfBucket(b);
    while (di + 1 < days.length && t > starts[di + 1]) di++; // the bucket whose end is exactly local midnight belongs to the day that just ended
    dayOfBucket[b] = di;
  }
  for (let d = 0; d < days.length; d++) dayStartBucket[d] = bucketOf(starts[d]) + 1;
  dayStartBucket[days.length] = n;
  // local hour and minute of each bucket end: from the day start and the elapsed minutes (clock changes shift this by one hour on 2 days a year)
  for (let b = 0; b < n; b++) {
    const mins = Math.round((msOfBucket(b) - starts[dayOfBucket[b]]) / 60_000);
    hourOfBucket[b] = Math.min(23, Math.floor(mins / 60) % 24);
    minuteOfBucket[b] = mins % 60;
  }
  return { days, dayOfBucket, hourOfBucket, minuteOfBucket, dayStartBucket, weekend: days.map((d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) };
}

export const localIsoOfBucket = (b: number) => utcMsToLocalIso(msOfBucket(b));

// ---------- DOT hourly means ----------
export interface Dot {
  links: string[];
  speed: Float32Array[]; // [link][dayIndex*24 + hour] mean speed of valid readings, NaN = none
  n: Uint8Array[]; // readings behind the mean (12 = every 5-minute report)
}

export function loadDot(days: string[]): Dot {
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const linkIndex = new Map<string, number>();
  const links: string[] = [];
  const speed: Float32Array[] = [];
  const nn: Uint8Array[] = [];
  const H = days.length * 24;
  for (const m of months()) {
    const rows = JSON.parse(read(`dot9__${m}.json`)) as { link_id: string; d: string; h: string; sp: string; n: string }[];
    for (const r of rows) {
      const di = dayIndex.get(r.d.slice(0, 10));
      if (di === undefined) continue;
      let li = linkIndex.get(r.link_id);
      if (li === undefined) {
        li = links.length;
        linkIndex.set(r.link_id, li);
        links.push(r.link_id);
        speed.push(new Float32Array(H).fill(NaN));
        nn.push(new Uint8Array(H));
      }
      const k = di * 24 + Number(r.h);
      speed[li][k] = Number(r.sp);
      nn[li][k] = Math.min(255, Number(r.n));
    }
  }
  return { links, speed, n: nn };
}
