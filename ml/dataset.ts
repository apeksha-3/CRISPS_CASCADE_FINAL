// ml/dataset.ts
// Phase 9 steps B and C: the tick data set.
//
// A TICK is a 5-minute bucket end inside a rain period: the largest 30-minute rain total at KNYC, KJFK or KLGA is at least
// 1.0 mm (RAIN_MIN_30MIN_MM). Ticks are grouped into rain EVENTS (a gap of more than 3 hours starts a new event); an event
// belongs to the split of its first tick, so no event spans two splits.
//
// TARGETS come from what happened afterwards (outcomes), never from a manual label:
//   y311      1 if the citywide count of 311 flood and drainage reports in the NEXT 60 minutes exceeds the 99th percentile of the
//             same quantity at the same clock hour on the preceding dry days (floor 5 reports).
//   ytraffic  1 if the share of healthy DOT links in slowdown in the next full clock hour exceeds the 99th percentile of the same
//             hour of day on the preceding dry days (floor 10%). DOT is hourly here, so this is an hourly target.
// BASELINES AND REGISTRY are rolling: for a tick on day D only the most recent dry days BEFORE D are used (same day type: weekday
// or weekend), never the future, never the rain days. This is what keeps the registry current (the Phase 8 drift fix).
//
// FEATURES use only what is known at the tick: rain now, 15/30/60-minute totals, peak intensity in the last hour, rain 25 to 1 hours ago,
// clock hour and month (as sine and cosine), 311 reports in the last 30 minutes (count and ratio to the dry-day mean), and the share of
// healthy DOT links in slowdown in the last COMPLETED hour (0 plus a flag when DOT has no data).

import { BUCKET_MS, bucketOf, type Calendar, type Dot, loadCalendar, type Rain, load311, loadDot, loadRain, localIsoOfBucket, msOfBucket, nBuckets, STATIONS } from "./series";

export const RAIN_MIN_30MIN_MM = 1.0;
export const EVENT_GAP_BUCKETS = 36; // 3 hours
export const DRY_DAY_MAX_MM = 0.1;
export const POOL_DAYS = 60; // dry days of the same type behind the threshold
export const MIN_POOL_DAYS = 30;
export const BASE_DAYS = 10; // dry days behind the DOT baselines and link health
export const P_THRESHOLD = 0.99;
export const FLOOR_311 = 5;
export const FLOOR_TRAFFIC = 0.1;
export const SLOWDOWN_FRACTION = 0.6;
export const LINK_DAY_SHARE = 0.7;

export const FEATURES = ["rate_now", "acc15", "acc30", "acc60", "peak60", "ante24", "hour_sin", "hour_cos", "month_sin", "month_cos", "c311_30", "r311", "dot_frac", "dot_ok"] as const;

export interface Tick {
  bucket: number;
  local: string; // "2021-09-01T21:30:00"
  event: string; // "2021-09-01T20:35"
  split: "train" | "validate" | "test";
  f: number[]; // FEATURES order
  y311: number;
  thr311: number;
  ytraffic: number; // NaN when DOT has no data for the target hour
  thrTraffic: number;
}

export interface Built {
  ticks: Tick[];
  dropped: Record<string, number>;
  dryDays: number;
}

const splitOf = (day: string): Tick["split"] => (day < "2024-01-01" ? "train" : day < "2025-01-01" ? "validate" : "test");

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const x = (sorted.length - 1) * q;
  const lo = Math.floor(x);
  return sorted[lo] + (sorted[Math.min(sorted.length - 1, lo + 1)] - sorted[lo]) * (x - lo);
}

// `inject` lets a test supply small synthetic series instead of the cached files.
export function buildDataset(withDot = true, inject?: { rain: Rain; c311: Int32Array }): Built {
  const cal = loadCalendar();
  const rain = inject?.rain ?? loadRain();
  const c311 = inject?.c311 ?? load311();
  const dot = withDot && !inject ? loadDot(cal.days) : undefined;
  const n = nBuckets();
  const days = cal.days;

  // ---- combined rain: max over stations of mm per bucket (NaN buckets count as 0 for totals) ----
  const mm = STATIONS.map((_, s) => Float32Array.from(rain.rate[s], (r) => (Number.isFinite(r) ? (r * 5) / 60 : 0)));
  const rateMax = new Float32Array(n).fill(NaN);
  for (let b = 0; b < n; b++) {
    let m = NaN;
    for (let s = 0; s < STATIONS.length; s++) { const r = rain.rate[s][b]; if (Number.isFinite(r) && !(m >= r)) m = r; }
    rateMax[b] = m;
  }
  const cum = mm.map((a) => { const c = new Float64Array(n + 1); for (let b = 0; b < n; b++) c[b + 1] = c[b] + a[b]; return c; });
  const accMax = (b: number, k: number) => { let m = 0; for (let s = 0; s < STATIONS.length; s++) m = Math.max(m, cum[s][b + 1] - cum[s][Math.max(0, b + 1 - k)]); return m; };
  const accRange = (b0: number, b1: number) => { let m = 0; for (let s = 0; s < STATIONS.length; s++) m = Math.max(m, cum[s][Math.min(n, Math.max(0, b1 + 1))] - cum[s][Math.max(0, b0)]); return m; };

  // ---- dry days: a day with at most 0.1 mm at every station, and valid rain data in most of it ----
  const dry: boolean[] = days.map((_, d) => {
    const b0 = cal.dayStartBucket[d];
    const b1 = cal.dayStartBucket[d + 1];
    let ok = 0;
    for (let b = b0; b < b1; b++) if (Number.isFinite(rateMax[b])) ok++;
    return ok >= 0.8 * (b1 - b0) && accRange(b0, b1 - 1) <= DRY_DAY_MAX_MM;
  });
  const dryAfterDry = dry.map((x, d) => x && d > 0 && dry[d - 1]); // dry and the day before was dry too
  const poolDays = (d: number, k: number): number[] => {
    const out: number[] = [];
    for (let e = d - 1; e >= 0 && out.length < k; e--) if (dryAfterDry[e] && cal.weekend[e] === cal.weekend[d]) out.push(e);
    return out;
  };

  // ---- 311 per-tick sums ----
  const cum311 = new Float64Array(n + 1);
  for (let b = 0; b < n; b++) cum311[b + 1] = cum311[b] + c311[b];
  const sum311 = (b0: number, b1: number) => cum311[Math.min(n, b1 + 1)] - cum311[Math.max(0, b0)];
  const fwd60 = (b: number) => sum311(b + 1, b + 12);
  const back30 = (b: number) => sum311(b - 5, b);
  const pool311 = new Map<string, { thr: number; mean30: number } | null>();
  const thr311 = (d: number, h: number) => {
    const key = `${d}|${h}`;
    if (pool311.has(key)) return pool311.get(key)!;
    const ds = poolDays(d, POOL_DAYS);
    let res: { thr: number; mean30: number } | null = null;
    if (ds.length >= MIN_POOL_DAYS) {
      const f: number[] = [];
      const bk: number[] = [];
      for (const e of ds) for (let b = cal.dayStartBucket[e]; b < cal.dayStartBucket[e + 1]; b++) if (cal.hourOfBucket[b] === h) { f.push(fwd60(b)); bk.push(back30(b)); }
      f.sort((a, c) => a - c);
      res = { thr: Math.max(FLOOR_311, quantile(f, P_THRESHOLD)), mean30: bk.reduce((a, c) => a + c, 0) / bk.length };
    }
    pool311.set(key, res);
    return res;
  };

  // ---- DOT: rolling link health, baselines and slowdown share ----
  interface DotBase { links: number[]; base: Float32Array[]; } // links = indexes of healthy links; base[hourOfDay] per link
  const dotBaseCache = new Map<number, DotBase | null>();
  const dotBase = (d: number): DotBase | null => {
    if (!dot) return null;
    if (dotBaseCache.has(d)) return dotBaseCache.get(d)!;
    const ds = poolDays(d, BASE_DAYS);
    let res: DotBase | null = null;
    if (ds.length >= 5) {
      const healthy: number[] = [];
      const base: Float32Array[] = Array.from({ length: 24 }, () => new Float32Array(dot.links.length).fill(NaN));
      for (let li = 0; li < dot.links.length; li++) {
        let good = 0;
        for (const e of ds) { let hrs = 0; for (let h = 0; h < 24; h++) if (dot.n[li][e * 24 + h] >= 6) hrs++; if (hrs >= 12) good++; }
        if (good >= Math.ceil(LINK_DAY_SHARE * ds.length)) {
          healthy.push(li);
          for (let h = 0; h < 24; h++) {
            let s = 0, c = 0;
            for (const e of ds) if (dot.n[li][e * 24 + h] >= 6) { s += dot.speed[li][e * 24 + h]; c++; }
            if (c >= 3) base[h][li] = s / c;
          }
        }
      }
      res = { links: healthy, base };
    }
    dotBaseCache.set(d, res);
    return res;
  };
  // share of healthy links (judged from base day `d`) in slowdown during hour h of day e; NaN if too few links reported
  const slowShare = (d: number, e: number, h: number): number => {
    const bs = dotBase(d);
    if (!bs || !dot) return NaN;
    let seen = 0, slow = 0;
    for (const li of bs.links) {
      const b = bs.base[h][li];
      const k = e * 24 + h;
      if (!(b > 0) || dot.n[li][k] < 6) continue;
      seen++;
      if (dot.speed[li][k] < SLOWDOWN_FRACTION * b) slow++;
    }
    return seen >= 20 ? slow / seen : NaN;
  };
  const poolTraffic = new Map<string, number | null>();
  const thrTraffic = (d: number, h: number): number | null => {
    const key = `${d}|${h}`;
    if (poolTraffic.has(key)) return poolTraffic.get(key)!;
    const ds = poolDays(d, POOL_DAYS);
    let res: number | null = null;
    if (ds.length >= MIN_POOL_DAYS && dotBase(d)) {
      const f = ds.map((e) => slowShare(d, e, h)).filter((x) => Number.isFinite(x)).sort((a, c) => a - c);
      if (f.length >= MIN_POOL_DAYS) res = Math.max(FLOOR_TRAFFIC, quantile(f, P_THRESHOLD));
    }
    poolTraffic.set(key, res);
    return res;
  };

  // ---- ticks and events ----
  const dropped: Record<string, number> = { "no rain data at the tick": 0, "fewer than 30 preceding dry days": 0, "data ends within 60 minutes": 0 };
  const ticks: Tick[] = [];
  let lastEligible = -1e9;
  let eventId = "";
  for (let b = 12; b < n - 12; b++) {
    if (accMax(b, 6) < RAIN_MIN_30MIN_MM) continue;
    if (!Number.isFinite(rateMax[b])) { dropped["no rain data at the tick"]++; continue; }
    if (b - lastEligible > EVENT_GAP_BUCKETS) eventId = localIsoOfBucket(b).slice(0, 16);
    lastEligible = b;
    const d = cal.dayOfBucket[b];
    const h = cal.hourOfBucket[b];
    const t311 = thr311(d, h);
    if (!t311) { dropped["fewer than 30 preceding dry days"]++; continue; }
    if (msOfBucket(b + 12) > msOfBucket(nBuckets() - 1)) { dropped["data ends within 60 minutes"]++; continue; }
    let peak = 0;
    for (let k = Math.max(0, b - 11); k <= b; k++) if (Number.isFinite(rateMax[k]) && rateMax[k] > peak) peak = rateMax[k];
    const c30 = back30(b);
    const hr = h + cal.minuteOfBucket[b] / 60;
    const month = +days[d].slice(5, 7);
    // DOT: last completed hour for the feature, next full hour for the target
    const minute = cal.minuteOfBucket[b];
    const hLast = h - 1; // the last COMPLETED clock hour: the hour before the one the tick is in
    const nextHour = minute === 0 ? h : h + 1; // the next full clock hour: the one starting at the tick, or the next one
    const dLast = hLast < 0 ? d - 1 : d;
    const fLast = dot && dLast >= 0 ? slowShare(d, dLast, (hLast + 24) % 24) : NaN;
    let ytr = NaN;
    let tthr = NaN;
    if (dot && nextHour < 24) {
      const tt = thrTraffic(d, nextHour);
      const fs = slowShare(d, d, nextHour);
      if (tt !== null && Number.isFinite(fs)) { tthr = tt; ytr = fs > tt ? 1 : 0; }
    }
    ticks.push({
      bucket: b,
      local: localIsoOfBucket(b),
      event: eventId,
      split: splitOf(days[cal.dayOfBucket[b]]),
      f: [
        rateMax[b],
        accMax(b, 3),
        accMax(b, 6),
        accMax(b, 12),
        peak,
        accRange(b - 300, b - 12),
        Math.sin((2 * Math.PI * hr) / 24),
        Math.cos((2 * Math.PI * hr) / 24),
        Math.sin((2 * Math.PI * (month - 1)) / 12),
        Math.cos((2 * Math.PI * (month - 1)) / 12),
        c30,
        (c30 + 1) / (t311.mean30 + 1),
        Number.isFinite(fLast) ? fLast : 0,
        Number.isFinite(fLast) ? 1 : 0,
      ],
      y311: fwd60(b) > t311.thr ? 1 : 0,
      thr311: t311.thr,
      ytraffic: ytr,
      thrTraffic: tthr,
    });
  }
  // an event belongs to the split of its FIRST tick
  const first = new Map<string, Tick["split"]>();
  for (const t of ticks) if (!first.has(t.event)) first.set(t.event, t.split);
  for (const t of ticks) t.split = first.get(t.event)!;
  return { ticks, dropped, dryDays: dry.filter(Boolean).length };
}

export { bucketOf, BUCKET_MS };
export type { Calendar, Dot };
