// tests/real-phase7.test.ts
// Phase 7: real NYC data. Fixture tests need no network and no cache. The tests marked (cache)
// read the episodes built by `npx tsx scripts/real/build.ts` / the cached raw files, and are skipped
// when those are absent (a fresh clone before the fetch).

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapt311, map311 } from "../real/adapt-311";
import { adaptCollisions } from "../real/adapt-collisions";
import { adaptDot } from "../real/adapt-dot";
import { adaptEms } from "../real/adapt-ems";
import { adaptRain } from "../real/adapt-rain";
import { baselineSpeed, buildBaselines, type Baselines } from "../real/baselines";
import { assignGateways, boardOfEmsCode, buildNeighbours, firstPoint, nearestZone, type RealZone, zoneIdOfBoard } from "../real/geo";
import { delayFor, finalize, Unmapped, type Obs } from "../real/obs";
import { parseDaily, pickDry, pickRain, rainCandidates } from "../real/select";
import { localIsoToUtcMs, utcMsToLocalIso, utcStringToMs } from "../real/tz";
import { validateEvent } from "../engine/validate";
import { makePolicy } from "../eval/baselines";
import { runEpisode } from "../eval/run";
import type { Episode } from "../sim/truth";
import { Engine } from "../engine/tick";

const zones: RealZone[] = [
  { zone_id: "mn12", name: "12 MANHATTAN", lat: 40.85, lon: -73.93, volume: 10, neighbours: [], gateway_id: "synth-gw0" },
  { zone_id: "bk01", name: "01 BROOKLYN", lat: 40.72, lon: -73.95, volume: 9, neighbours: [], gateway_id: "synth-gw1" },
  { zone_id: "qn05", name: "05 QUEENS", lat: 40.71, lon: -73.89, volume: 8, neighbours: [], gateway_id: "synth-gw2" },
];
const gw = new Map(zones.map((z) => [z.zone_id, z.gateway_id]));

describe("UTC <-> NYC local time (real timezone rules)", () => {
  it("Ida: 01:28 UTC on 2 Sep is 21:28 EDT on 1 Sep (known pair)", () => {
    expect(utcMsToLocalIso(Date.UTC(2021, 8, 2, 1, 28, 0))).toBe("2021-09-01T21:28:00");
    expect(localIsoToUtcMs("2021-09-01T21:28:00")).toBe(Date.UTC(2021, 8, 2, 1, 28, 0));
  });
  it("winter is EST (UTC-5), not EDT", () => {
    expect(utcMsToLocalIso(Date.UTC(2022, 0, 13, 13, 0, 0))).toBe("2022-01-13T08:00:00");
    expect(localIsoToUtcMs("2022-01-13T08:00:00")).toBe(Date.UTC(2022, 0, 13, 13, 0, 0));
  });
  it("the spring clock change is handled: 07:30 UTC on 13 Mar 2022 is 03:30 EDT", () => {
    expect(utcMsToLocalIso(Date.UTC(2022, 2, 13, 7, 30, 0))).toBe("2022-03-13T03:30:00");
    expect(utcMsToLocalIso(Date.UTC(2022, 2, 13, 6, 30, 0))).toBe("2022-03-13T01:30:00");
  });
  it("IEM valid(UTC) text and a Socrata floating timestamp agree on the same instant", () => {
    expect(utcStringToMs("2021-09-02 01:28")).toBe(localIsoToUtcMs("2021-09-01T21:28:00.000"));
  });
});

describe("control-day selection rules (fixture)", () => {
  const daily = parseDaily([
    { station: "NYC", day: "2022-07-18", precip_in: "1.85" }, // Monday
    { station: "NYC", day: "2022-07-19", precip_in: "1.2" }, // adjacent to the heaviest: not both
    { station: "NYC", day: "2022-07-23", precip_in: "1.5" }, // Saturday: not a weekday
    { station: "NYC", day: "2021-09-01", precip_in: "7.13" }, // too heavy AND inside a cascade window
    { station: "NYC", day: "2022-10-04", precip_in: "1.4" }, // an NWS emergency day: rejected by the caller
    { station: "NYC", day: "2022-11-08", precip_in: "1.1" },
  ]);
  it("rain days: weekday, 1.0 to 2.5 in, away from cascade windows, no adjacent days, emergencies rejected", () => {
    const cands = rainCandidates(daily);
    expect(cands.map((c) => c.day)).toEqual(["2022-07-18", "2022-10-04", "2022-07-19", "2022-11-08"]);
    expect(pickRain(cands, (d) => d === "2022-10-04")).toEqual(["2022-07-18", "2022-11-08"]);
  });
  it("dry days: Tue-Thu, zero rain at all three stations that day and the day before, nearest to the target", () => {
    const dry: Record<string, string>[] = [];
    for (const day of ["2022-01-10", "2022-01-11", "2022-01-12", "2022-01-13"]) for (const st of ["NYC", "JFK", "LGA"]) dry.push({ station: st, day, precip_in: "0.00" });
    dry.push({ station: "NYC", day: "2022-01-12", precip_in: "T" }); // a trace on the 12th: not dry
    const got = pickDry(parseDaily(dry));
    expect(got[0]).toBe("2022-01-11"); // the 13th is as near, but its day before (the 12th) had a trace
  });
});

describe("zones and geography", () => {
  it("community board names become zone ids; junk is rejected", () => {
    expect(zoneIdOfBoard("12 MANHATTAN")).toBe("mn12");
    expect(zoneIdOfBoard("05 STATEN ISLAND")).toBe("si05");
    expect(zoneIdOfBoard("Unspecified")).toBeUndefined();
    expect(zoneIdOfBoard("0 Unspecified")).toBeUndefined();
    expect(boardOfEmsCode("112")).toBe("12 MANHATTAN");
    expect(boardOfEmsCode("305")).toBe("05 BROOKLYN");
    expect(boardOfEmsCode("999")).toBeUndefined();
  });
  it("nearest centroid, with a distance cutoff", () => {
    expect(nearestZone(zones, 40.851, -73.931)).toBe("mn12");
    expect(nearestZone(zones, 41.5, -74.5)).toBeUndefined();
    expect(firstPoint("40.60,-74.13 40.61,-74.14")).toEqual({ lat: 40.6, lon: -74.13 });
    expect(firstPoint("")).toBeUndefined();
  });
  it("neighbours are symmetric and gateways are synthetic and cover every zone", () => {
    const nb = buildNeighbours(zones, 1);
    for (const [a, list] of Object.entries(nb)) for (const b of list) expect(nb[b]).toContain(a);
    const g = assignGateways(zones);
    expect(Object.keys(g).sort()).toEqual(["bk01", "mn12", "qn05"]);
    for (const v of Object.values(g)) expect(v).toMatch(/^synth-gw\d$/);
  });
});

describe("adapters (fixtures)", () => {
  const T = localIsoToUtcMs("2022-01-13T08:10:00");
  const FROM = localIsoToUtcMs("2022-01-13T08:00:00");
  const TO = localIsoToUtcMs("2022-01-13T08:45:00");

  it("311: flooding, drainage and electric map; everything else is counted, not invented", () => {
    expect(map311("Sewer", "Street Flooding (SJ)")?.kind).toBe("citizen_report");
    expect(map311("Sewer", "Catch Basin Clogged/Flooding (Use Comments) (SC)")?.kind).toBe("drainage_anomaly");
    expect(map311("Water System", "Excessive Water In Basement (WEFB)")?.kind).toBe("citizen_report");
    expect(map311("ELECTRIC", "")?.kind).toBe("power_comms_load");
    expect(map311("Water System", "Hydrant Running (WC3)")).toBeUndefined();
    const u = new Unmapped();
    const rows = [
      { unique_key: "1", created_date: "2022-01-13T08:10:00.000", complaint_type: "Sewer", descriptor: "Street Flooding (SJ)", community_board: "12 MANHATTAN" },
      { unique_key: "2", created_date: "2022-01-13T08:11:00.000", complaint_type: "Sewer", descriptor: "Street Flooding (SJ)", community_board: "03 BRONX" }, // not a selected zone
      { unique_key: "3", created_date: "2022-01-13T08:12:00.000", complaint_type: "Water System", descriptor: "Hydrant Running (WC3)", community_board: "12 MANHATTAN" },
      { unique_key: "4", created_date: "2022-01-13T08:13:00.000", complaint_type: "ELECTRIC", descriptor: "", community_board: "Unspecified" },
    ];
    const obs = adapt311(rows, zones, FROM, TO, u);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ source_id: "cit-mn12", source_type: "citizen_report", kind: "citizen_report", zone_id: "mn12" });
    expect(obs[0].reported_severity).toBeUndefined(); // 311 has no severity: none invented
    expect(Object.values(u.counts).reduce((a, b) => a + b, 0)).toBe(3);
    expect(Object.keys(u.counts).some((k) => k.includes("not one of the 10 selected zones"))).toBe(true);
  });

  const base = (mean: number, n = 20): Baselines => ({ days: ["d"], speed: new Map([["L1|8", { mean, n }]]), calls: new Map(), hospital: new Map() });
  const dotRow = (id: string, minute: string, speed: string, status = "0") => ({ id, link_id: "L1", data_as_of: `2022-01-13T08:${minute}:00.000`, speed, travel_time: "100", status });

  it("DOT: heartbeat per valid report, slowdown below 60% of the link's own baseline, severity = 1 - speed/baseline", () => {
    const u = new Unmapped();
    const rows = [dotRow("a", "10", "45"), dotRow("b", "15", "20"), dotRow("c", "20", "0.00", "-101"), dotRow("d", "25", "n/a")];
    const obs = adaptDot(rows, new Map([["L1", "mn12"]]), gw, base(50), FROM, TO, u);
    expect(obs.map((o) => `${o.kind}`).sort()).toEqual(["heartbeat", "heartbeat", "traffic_slowdown"]);
    const slow = obs.find((o) => o.kind === "traffic_slowdown")!;
    expect(slow.reported_severity).toBeCloseTo(0.6, 2); // 1 - 20/50
    expect(slow.value).toBeCloseTo(60, 1);
    expect(slow.gateway_id).toBe("synth-gw0");
    expect(Object.values(u.counts)).toEqual([1, 1]); // one -101 silence, one non-numeric speed
  });
  it("DOT: event ids are unique per report even though the DOT `id` column repeats for each link", () => {
    const rows = [dotRow("119", "10", "20"), dotRow("119", "15", "20"), dotRow("119", "20", "20")];
    const obs = adaptDot(rows, new Map([["L1", "mn12"]]), gw, base(50), FROM, TO, new Unmapped());
    expect(new Set(obs.map((o) => o.id)).size).toBe(obs.length);
    expect(obs).toHaveLength(6);
  });
  it("DOT: no baseline (too few dry-day samples) means reported but not scored, and it is counted", () => {
    const u = new Unmapped();
    const obs = adaptDot([dotRow("a", "15", "5")], new Map([["L1", "mn12"]]), gw, base(50, 3), FROM, TO, u);
    expect(obs.map((o) => o.kind)).toEqual(["heartbeat"]);
    expect(Object.keys(u.counts)[0]).toContain("no dry-day baseline");
    const u2 = new Unmapped();
    adaptDot([dotRow("a", "15", "5")], new Map(), gw, base(50), FROM, TO, u2);
    expect(Object.keys(u2.counts)[0]).toContain("no zone");
  });

  it("rain: 5-minute buckets, heartbeat always, rain_heavy at 7.6 mm/h and up, severity = mm/h / 50", () => {
    const rows: Record<string, string>[] = [];
    for (let m = 1; m <= 10; m++) rows.push({ station: "NYC", "valid(UTC)": `2022-01-13 13:${String(m).padStart(2, "0")}`, precip: m <= 5 ? "0.0" : "0.01" }); // 0.01 in/min = 15.2 mm/h
    rows.push({ station: "NYC", "valid(UTC)": "2022-01-13 13:11", precip: "0.0" }, { station: "NYC", "valid(UTC)": "2022-01-13 13:12", precip: "M" });
    const u = new Unmapped();
    const obs = adaptRain(rows, { NYC: "mn12", JFK: "mn12", LGA: "mn12" }, gw, FROM, TO, u);
    const heavy = obs.filter((o) => o.kind === "rain_heavy");
    expect(heavy).toHaveLength(1);
    expect(heavy[0].value).toBeCloseTo(15.2, 1);
    expect(heavy[0].reported_severity).toBeCloseTo(0.3, 2);
    expect(obs.filter((o) => o.kind === "heartbeat")).toHaveLength(2);
    expect(Object.values(u.counts)[0]).toBe(1); // the bucket with one valid minute is a missing report
  });

  it("EMS: a spike needs a real excess over the dry-day baseline; severity from the code (1 = most severe)", () => {
    const rows: Record<string, string>[] = [];
    for (let i = 0; i < 6; i++) rows.push({ incident_id: String(i), incident_datetime: `2022-01-13T08:2${i}:00.000`, initial_severity_level_code: "2", first_hosp_arrival_datetime: "", communitydistrict: "112", borough: "MANHATTAN" });
    rows.push({ incident_id: "x", incident_datetime: "2022-01-13T08:20:00.000", initial_severity_level_code: "4", first_hosp_arrival_datetime: "", communitydistrict: "999", borough: "?" });
    const b: Baselines = { days: [], speed: new Map(), calls: new Map([["mn12|8", 6]]), hospital: new Map() }; // 6 calls/hour = 1 per 10 min
    const u = new Unmapped();
    const spikes = adaptEms(rows, zones, b, FROM, TO, u).filter((o) => o.kind === "emergency_call_spike");
    expect(spikes.length).toBeGreaterThan(0);
    expect(spikes[0].reported_severity).toBeCloseTo((9 - 2) / 8, 1);
    expect(Object.keys(u.counts)[0]).toContain("no usable community district");
    const none = adaptEms(rows, zones, { ...b, calls: new Map([["mn12|8", 600]]) }, FROM, TO, new Unmapped()).filter((o) => o.kind === "emergency_call_spike");
    expect(none).toHaveLength(0); // a busy zone: the same 6 calls are normal
  });

  it("collisions: severity table, nearest zone, missing coordinates counted", () => {
    const u = new Unmapped();
    const base2 = { crash_date: "2022-01-13T00:00:00.000", crash_time: "8:30", borough: "BRONX", number_of_persons_injured: "0", number_of_persons_killed: "0" };
    const obs = adaptCollisions(
      [
        { ...base2, collision_id: "1", latitude: "40.851", longitude: "-73.931", number_of_persons_injured: "2" },
        { ...base2, collision_id: "2", latitude: "", longitude: "" },
        { ...base2, collision_id: "3", latitude: "40.851", longitude: "-73.931", number_of_persons_killed: "1" },
      ],
      zones,
      FROM,
      TO,
      u,
    );
    expect(obs.map((o) => o.reported_severity)).toEqual([0.6, 0.9]);
    expect(obs[0].source_id).toBe("col-mn12");
    expect(Object.values(u.counts)).toEqual([1]);
  });

  it("delivery delay is deterministic per (episode, event) and inside the simulator's range", () => {
    expect(delayFor("ep1", "e1", "traffic_sensor")).toBe(delayFor("ep1", "e1", "traffic_sensor"));
    const ds = new Set(Array.from({ length: 50 }, (_, i) => delayFor("ep1", `e${i}`, "traffic_sensor")));
    expect(ds.size).toBeGreaterThan(5);
    for (const d of ds) expect(d).toBeGreaterThanOrEqual(5);
    expect(Math.max(...ds)).toBeLessThanOrEqual(90 + 120);
    const o: Obs = { id: "x", source_id: "trf-1", source_type: "traffic_sensor", zone_id: "mn12", kind: "traffic_slowdown", t_ms: T, value: 50, reported_severity: 0.5 };
    const a = finalize([o], "ep1", FROM);
    expect(finalize([o], "ep1", FROM)).toEqual(a);
    expect(a[0].occurred_at).toBe(Math.round((T - FROM) / 1000));
    expect(a[0].arrived_at).toBeGreaterThan(a[0].occurred_at);
    expect(finalize([{ ...o, t_ms: FROM - 1000 }], "ep1", FROM)).toHaveLength(0); // before the episode
  });
});

describe("baselines use dry control days only (fixture cache)", () => {
  it("the mean comes from the dry days; leave-one-day-out drops the evaluated day; cascade files are never read", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-fixture-"));
    process.env.REAL_RAW_DIR = dir;
    try {
      const mk = (speed: string) => JSON.stringify([{ id: "1", link_id: "L1", data_as_of: "2022-03-01T08:05:00.000", speed, travel_time: "1", status: "0" }]);
      writeFileSync(join(dir, "dot-speeds__dry-2022-03-01.json"), mk("40"));
      writeFileSync(join(dir, "dot-speeds__dry-2022-03-02.json"), mk("60"));
      writeFileSync(join(dir, "ems__dry-2022-03-01.json"), "[]");
      writeFileSync(join(dir, "ems__dry-2022-03-02.json"), "[]");
      // a cascade-like window with a wildly different speed: it must not matter (nothing reads it)
      writeFileSync(join(dir, "dot-speeds__ida-2021.json"), mk("1"));
      const all = buildBaselines(["2022-03-01", "2022-03-02"], zones);
      expect(all.speed.get("L1|8")).toEqual({ mean: 50, n: 2 });
      const loo = buildBaselines(["2022-03-01", "2022-03-02"], zones, "2022-03-01");
      expect(loo.days).toEqual(["2022-03-02"]);
      expect(loo.speed.get("L1|8")).toEqual({ mean: 60, n: 1 });
      expect(baselineSpeed(all, "L1", 8)).toBeUndefined(); // 2 samples < 8: not trusted
    } finally {
      delete process.env.REAL_RAW_DIR;
    }
  });
  it("the adapters never receive a baseline built from the day they score (episodes.ts uses leave-one-out for dry days)", () => {
    const src = readFileSync(join(__dirname, "..", "real", "episodes.ts"), "utf8");
    expect(src).toMatch(/buildBaselines\(dry, ctx\.zones, day\)/);
    expect(src).toMatch(/buildBaselines\(dry, ctx\.zones\)/); // cascades and rain days: dry days only
  });
});

describe("firewall: engine/ imports nothing from sim/, eval/ or real/", () => {
  const tsFiles = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? tsFiles(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
  it("scans static, dynamic and require imports", () => {
    for (const file of tsFiles(join(__dirname, "..", "engine"))) {
      const src = readFileSync(file, "utf8");
      for (const dir of ["sim", "eval", "real"]) {
        expect(src, file).not.toMatch(new RegExp(`from\\s+["'][^"']*\\b${dir}(\\/|["'])`));
        expect(src, file).not.toMatch(new RegExp(`import\\(\\s*["'][^"']*\\b${dir}(\\/|["'])`));
        expect(src, file).not.toMatch(new RegExp(`require\\(\\s*["'][^"']*\\b${dir}(\\/|["'])`));
      }
    }
  });
  it("real/ copies the delay model instead of importing sim/ (type-only imports of the Episode shape excepted)", () => {
    for (const file of tsFiles(join(__dirname, "..", "real"))) {
      const src = readFileSync(file, "utf8");
      const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*from\s+["']\.\.\/sim\/[^"']+["']/gm)];
      for (const m of imports) expect(m[1], `${file}: ${m[0]}`).toBeTruthy(); // must be `import type`
    }
  });
  it("engine, config, sim and eval are byte-identical to the Phase 6 freeze (git diff d84a71c)", () => {
    let out: string | undefined;
    try {
      out = execSync("git diff d84a71c -- engine config sim eval", { cwd: join(__dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return; // no git history here (e.g. a source archive): nothing to compare
    }
    expect(out).toBe("");
  });
});

describe("labels", () => {
  const labels = JSON.parse(readFileSync(join(__dirname, "..", "real", "labels.json"), "utf8"));
  it("every label cites a URL; only cited classes exist (no invented SENSOR_FAILURE or ISOLATED)", () => {
    for (const c of labels.cascades) {
      expect(c.onset_source.url).toMatch(/^https:\/\//);
      expect(c.critical_source.url).toMatch(/^https:\/\//);
      expect(c.confidence.length).toBeGreaterThan(20);
      expect(["NOISE", "CASCADING_CRISIS"]).toContain(c.hypothesis);
    }
    for (const c of Object.values(labels.controls) as { source: { url: string }; hypothesis: string }[]) {
      expect(c.source.url).toMatch(/^https:\/\//);
      expect(c.hypothesis).toBe("NOISE");
    }
    expect(Object.keys(labels.empty_classes)).toEqual(expect.arrayContaining(["SENSOR_FAILURE", "ISOLATED_INCIDENT"]));
  });
});

describe("eval handles null stage times (no onset, no critical time, no stage times)", () => {
  const registry = { zones: [{ zone_id: "mn12", name: "12 MANHATTAN", neighbours: [] }], gateways: [], sources: [{ source_id: "cit-mn12", source_type: "citizen_report" as const, zone_id: "mn12", heartbeat_interval_s: 3600, nominal_latency_s: 60 }] };
  const ep = {
    episode_id: "fixture-null-times",
    seed: 1,
    type: "cascade",
    duration: 600,
    registry,
    events: [{ id: "e1", source_id: "cit-mn12", source_type: "citizen_report", zone_id: "mn12", kind: "citizen_report", occurred_at: 30, arrived_at: 70, text: "311 street flooding" }],
    truth: { hypothesis: "CASCADING_CRISIS", episode_type: "cascade", stage_times: {}, stages: [], build_attempt: 0, cutouts: [], failed_gateways: [], surge: false, drifting_sources: [], weather: "normal", sources: [], event_truths: {} },
  } as unknown as Episode;
  it("engine, count-threshold and always-watch run to the end with finite scores and no lead time", () => {
    for (const name of ["engine", "count-threshold", "always-watch"]) {
      const { result } = runEpisode(makePolicy(name, "real" as never), ep);
      expect(result.ticks).toBe(10);
      expect(Number.isFinite(result.brier)).toBe(true);
      expect(result.lead_min).toBeUndefined();
      expect(result.forecast_start_hits).toBe(0);
    }
  });
  it("a bad event does not crash the engine either (unknown zone is quarantined, not fatal)", () => {
    const e = new Engine(registry);
    const rec = e.tick([{ id: "x", source_id: "cit-mn12", source_type: "citizen_report", zone_id: "nowhere", kind: "citizen_report", occurred_at: 1, arrived_at: 2 }], 60);
    expect(rec.quarantined).toHaveLength(1);
  });
});

const BUILT = join(__dirname, "..", "data", "episodes", "real");
const haveBuilt = existsSync(BUILT) && readdirSync(BUILT).length > 0;
const EVENT_KEYS = new Set(["id", "source_id", "source_type", "gateway_id", "zone_id", "kind", "value", "reported_severity", "occurred_at", "arrived_at", "retracts", "text", "narrative_id"]);

describe.skipIf(!haveBuilt)("built real episodes (cache)", () => {
  const eps = haveBuilt ? readdirSync(BUILT).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(BUILT, f), "utf8")) as Episode) : [];
  it("every event validates against the Event type, with no hidden fields", () => {
    expect(eps.length).toBeGreaterThan(20);
    for (const ep of eps) {
      const zoneIds = new Set(ep.registry.zones.map((z) => z.zone_id));
      for (const e of ep.events) {
        for (const k of Object.keys(e)) expect(EVENT_KEYS.has(k), `${ep.episode_id}: field ${k}`).toBe(true);
        expect("valid" in validateEvent(e, { now: ep.duration + 600, zones: zoneIds }), `${ep.episode_id} ${e.id}`).toBe(true);
      }
      for (const s of ep.registry.sources) expect(Object.keys(s).sort()).toEqual(["gateway_id", "heartbeat_interval_s", "nominal_latency_s", "source_id", "source_type", "zone_id"].filter((k) => k in s).sort());
      for (const g of ep.registry.gateways as unknown as { gateway_id: string; synthetic: boolean }[]) {
        expect(g.synthetic).toBe(true);
        expect(g.gateway_id).toMatch(/^synth-gw/);
      }
      expect(ep.truth.event_truths).toEqual({}); // real data has no per-event truth
    }
  });
  it("event ids are unique inside every episode (the engine's log drops repeated ids)", () => {
    for (const ep of eps) expect(new Set(ep.events.map((e) => e.id)).size, ep.episode_id).toBe(ep.events.length);
  });
  it("the real cascades have null stage times and the other classes are as labelled", () => {
    const cas = eps.filter((e) => e.truth.hypothesis === "CASCADING_CRISIS");
    expect(cas.length).toBe(6);
    for (const c of cas) expect(c.truth.stage_times).toEqual({});
    expect(eps.some((e) => e.truth.hypothesis === "SENSOR_FAILURE" || e.truth.hypothesis === "ISOLATED_INCIDENT")).toBe(false);
    expect(cas.filter((c) => c.episode_id.includes("flood-2023")).every((c) => c.truth.onset === undefined && c.truth.critical_time === undefined)).toBe(true);
    expect(cas.filter((c) => c.episode_id.includes("ida")).every((c) => c.truth.onset !== undefined && c.truth.critical_time !== undefined)).toBe(true);
  });
  it("rebuilding from the same cache gives byte-identical episodes", async () => {
    const { loadContext } = await import("../real/context");
    const { buildAll } = await import("../real/episodes");
    const ctx = loadContext();
    const a = buildAll(ctx, new Unmapped()).map((b) => JSON.stringify(b.episode));
    const b = buildAll(ctx, new Unmapped()).map((b2) => JSON.stringify(b2.episode));
    expect(a.length).toBe(34);
    expect(b).toEqual(a);
    const onDisk = readdirSync(BUILT).filter((f) => f.endsWith(".json")).sort().map((f) => readFileSync(join(BUILT, f), "utf8"));
    expect([...a].sort()).toEqual([...onDisk].sort());
  }, 120_000);
});
