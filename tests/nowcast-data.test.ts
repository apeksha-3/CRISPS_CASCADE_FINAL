// tests/nowcast-data.test.ts
// Phase 9: the tick data set has no leakage. Features may only use the past of a tick; targets only its future.
// Uses small synthetic series (injected) so it needs no network and no cache.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildDataset, FEATURES, quantile } from "../ml/dataset";
import { bucketOf, loadCalendar, localIsoOfBucket, msOfBucket, nBuckets, STATIONS } from "../ml/series";
import { localIsoToUtcMs } from "../real/tz";

describe("buckets and calendar", () => {
  const cal = loadCalendar();
  it("a bucket is stamped with its end, and the index round-trips", () => {
    for (const i of [1, 1000, 123456]) expect(bucketOf(msOfBucket(i))).toBe(i);
    expect(bucketOf(msOfBucket(10) - 1)).toBe(10); // a minute inside the bucket belongs to it
    expect(bucketOf(msOfBucket(10) + 1)).toBe(11);
  });
  it("local hour, minute and day of a bucket (EDT, and EST in winter)", () => {
    const b = bucketOf(localIsoToUtcMs("2021-09-01T21:30:00")); // Ida
    expect(localIsoOfBucket(b)).toBe("2021-09-01T21:30:00");
    expect(cal.hourOfBucket[b]).toBe(21);
    expect(cal.minuteOfBucket[b]).toBe(30);
    expect(cal.days[cal.dayOfBucket[b]]).toBe("2021-09-01");
    const w = bucketOf(localIsoToUtcMs("2022-01-13T08:05:00"));
    expect(cal.hourOfBucket[w]).toBe(8);
    expect(cal.minuteOfBucket[w]).toBe(5);
  });
  it("the bucket that ends exactly at local midnight belongs to the day that just ended", () => {
    const b = bucketOf(localIsoToUtcMs("2021-09-02T00:00:00"));
    expect(cal.days[cal.dayOfBucket[b]]).toBe("2021-09-01");
    expect(cal.days[cal.dayOfBucket[b + 1]]).toBe("2021-09-02");
  });
  it("weekend flags", () => {
    expect(cal.weekend[cal.days.indexOf("2022-01-15")]).toBe(true); // a Saturday
    expect(cal.weekend[cal.days.indexOf("2022-01-13")]).toBe(false); // a Thursday
  });
});

describe("quantile", () => {
  it("interpolates and handles tiny inputs", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([0, 10], 0.99)).toBeCloseTo(9.9, 9);
    expect(quantile([7], 0.99)).toBe(7);
  });
});

// A synthetic world: dry everywhere, no 311, except one storm. 311 reports appear AFTER the storm starts.
function world(extra311: (c: Int32Array, stormStart: number) => void) {
  const n = nBuckets();
  const rate = STATIONS.map(() => new Float32Array(n).fill(0));
  const stormStart = bucketOf(localIsoToUtcMs("2022-07-20T15:00:00"));
  for (let k = 0; k < 18; k++) for (const r of rate) r[stormStart + k] = 30; // 90 minutes of 30 mm/h
  const c311 = new Int32Array(n);
  extra311(c311, stormStart);
  return { rain: { rate }, c311, stormStart };
}

describe("no leakage in the tick data set", () => {
  const base = world((c, s) => { for (let k = 2; k < 14; k++) c[s + k] = 3; }); // 36 reports in the hour after the storm starts
  const a = buildDataset(false, { rain: base.rain, c311: base.c311 });

  it("builds ticks only inside the storm, grouped into one event, in the right split", () => {
    expect(a.ticks.length).toBeGreaterThan(10);
    expect(new Set(a.ticks.map((t) => t.event)).size).toBe(1);
    expect(a.ticks.every((t) => t.split === "train")).toBe(true);
    expect(a.ticks.every((t) => t.f.length === FEATURES.length)).toBe(true);
  });
  it("a tick's target is the NEXT 60 minutes against a dry-day threshold, and a quiet future gives 0", () => {
    const early = a.ticks.find((t) => t.bucket === base.stormStart + 5)!; // tick 25 min into the storm: reports follow in the next hour
    expect(early.thr311).toBe(5); // no reports on dry days: the floor
    expect(early.y311).toBe(1);
    const quiet = world(() => {});
    const q = buildDataset(false, { rain: quiet.rain, c311: quiet.c311 });
    expect(q.ticks.every((t) => t.y311 === 0)).toBe(true);
  });
  it("changing the FUTURE changes the target but never a feature", () => {
    const alt = world((c, s) => { for (let k = 2; k < 14; k++) c[s + k] = 3; c[s + 9] = 100; c[s + 10] = 100; }); // a burst after tick s+8
    const b = buildDataset(false, { rain: alt.rain, c311: alt.c311 });
    const t = a.ticks.find((x) => x.bucket === base.stormStart + 6)!;
    const u = b.ticks.find((x) => x.bucket === base.stormStart + 6)!;
    expect(u.f).toEqual(t.f); // the burst is later than the tick: no feature may see it
    expect(u.y311).toBe(t.y311);
    const later = world((c, s) => { for (let k = 2; k < 14; k++) c[s + k] = 3; c[s + 40] = 500; }); // a burst long after the 60-minute horizon of tick s+6
    const l = buildDataset(false, { rain: later.rain, c311: later.c311 });
    expect(l.ticks.find((x) => x.bucket === base.stormStart + 6)!.f).toEqual(t.f);
  });
  it("changing the PAST changes the 311 features", () => {
    const past = world((c, s) => { for (let k = 2; k < 14; k++) c[s + k] = 3; c[s + 4] = 50; });
    const p = buildDataset(false, { rain: past.rain, c311: past.c311 });
    const t = a.ticks.find((x) => x.bucket === base.stormStart + 6)!;
    const u = p.ticks.find((x) => x.bucket === base.stormStart + 6)!;
    expect(u.f[FEATURES.indexOf("c311_30")]).toBeGreaterThan(t.f[FEATURES.indexOf("c311_30")]);
  });
  it("rain features at a tick equal what the rain up to that tick says (changing later rain changes nothing)", () => {
    const heavier = world(() => {});
    for (const r of heavier.rain.rate) for (let k = 12; k < 18; k++) r[heavier.stormStart + k] = 90; // the storm gets worse AFTER tick s+8
    const h = buildDataset(false, { rain: heavier.rain, c311: base.c311 });
    const t = a.ticks.find((x) => x.bucket === base.stormStart + 8)!;
    const u = h.ticks.find((x) => x.bucket === base.stormStart + 8)!;
    expect(u.f.slice(0, 6)).toEqual(t.f.slice(0, 6));
  });
});

describe("firewall: the engine does not import ml/", () => {
  const tsFiles = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? tsFiles(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
  it("no engine, config, sim or eval file imports ml/ (the model is not wired into the engine; since Phase 10 only the dashboard server reads it)", () => {
    for (const d of ["engine", "config", "sim", "eval"]) for (const file of tsFiles(join(__dirname, "..", d))) expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+["'][^"']*\bml(\/|["'])/);
  });
});
