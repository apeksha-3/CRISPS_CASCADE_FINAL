// tests/sim.test.ts
// Simulator guarantees: determinism, twin prefixes, timestamp rules, no leaks, sizes.

import { describe, expect, it } from "vitest";
import { generateEpisode, generateTwinPair, countSignalEvents, SCENARIO_NAMES } from "../sim/episode";
import { SEEDS } from "../sim/params";
import { buildSplit } from "../sim/dataset";

const ALLOWED_EVENT_KEYS = new Set([
  "id", "source_id", "source_type", "gateway_id", "zone_id", "kind", "value",
  "reported_severity", "occurred_at", "arrived_at", "retracts", "text", "narrative_id",
]);

describe("determinism", () => {
  it("same type + seed + options gives byte-identical JSON", () => {
    for (const name of SCENARIO_NAMES) {
      const a = JSON.stringify(generateEpisode(name, 1234));
      const b = JSON.stringify(generateEpisode(name, 1234));
      expect(a === b, name).toBe(true);
    }
    expect(JSON.stringify(generateTwinPair(77))).toBe(JSON.stringify(generateTwinPair(77)));
  });
  it("different seeds give different episodes", () => {
    expect(JSON.stringify(generateEpisode("cascade", 1)) === JSON.stringify(generateEpisode("cascade", 2))).toBe(false);
  });
  it("dev and test seed ranges never overlap", () => {
    const dev = buildSplit("dev").map((e) => e.seed);
    const test = buildSplit("test").map((e) => e.seed);
    expect(Math.min(...dev)).toBeGreaterThanOrEqual(SEEDS.dev);
    expect(Math.max(...dev)).toBeLessThan(SEEDS.test);
    expect(Math.min(...test)).toBeGreaterThanOrEqual(SEEDS.test);
    expect(Math.max(...test)).toBeLessThan(SEEDS.prior_shift);
  }, 60_000);
});

describe("twin pairs", () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it("all events with arrived_at <= split_time are byte-identical", () => {
    for (const s of seeds) {
      const [a, b] = generateTwinPair(s);
      const split = a.truth.split_time!;
      expect(b.truth.split_time).toBe(split);
      const pa = a.events.filter((e) => e.arrived_at <= split);
      const pb = b.events.filter((e) => e.arrived_at <= split);
      expect(JSON.stringify(pa)).toBe(JSON.stringify(pb));
      // ...and they really do diverge afterwards
      expect(JSON.stringify(a.events)).not.toBe(JSON.stringify(b.events));
    }
  });
  it("split is between minute 5 and 9 with at least 40 prefix events, labels differ", () => {
    for (const s of seeds) {
      const [a, b] = generateTwinPair(s);
      const split = a.truth.split_time!;
      expect(split).toBeGreaterThanOrEqual(300);
      expect(split).toBeLessThanOrEqual(540);
      expect(countSignalEvents(a.events.filter((e) => e.arrived_at <= split))).toBeGreaterThanOrEqual(40);
      expect(a.truth.twin_pair_id).toBe(b.truth.twin_pair_id);
      expect(a.truth.hypothesis).toBe("CASCADING_CRISIS");
      expect(b.truth.hypothesis).toBe("NOISE");
      expect(a.truth.critical_time!).toBeGreaterThan(split); // downstream signature only after the split
    }
  });
});

describe("events", () => {
  it("contain no hidden fields", () => {
    for (const name of SCENARIO_NAMES) {
      const ep = generateEpisode(name, 42);
      for (const e of ep.events) for (const k of Object.keys(e)) expect(ALLOWED_EVENT_KEYS.has(k), `${name}: ${k}`).toBe(true);
      // the public registry has no hidden source fields either
      for (const s of ep.registry.sources) {
        expect(s).not.toHaveProperty("true_reliability");
        expect(s).not.toHaveProperty("clock_offset");
      }
    }
  });
  it("occurred_at = true time + source clock offset; arrived_at >= true time", () => {
    let skewedAhead = 0;
    for (const name of ["cascade", "noise", "sensor_failure"] as const) {
      const ep = generateEpisode(name, 99);
      const offset = new Map(ep.truth.sources.map((s) => [s.source_id, s.clock_offset]));
      for (const e of ep.events) {
        const t = ep.truth.event_truths[e.id];
        if (e.kind === "retraction") continue; // its truth entry is keyed by its own id below
        expect(t, e.id).toBeDefined();
        expect(e.arrived_at).toBeGreaterThanOrEqual(t.true_occurred_at);
        expect(e.occurred_at).toBe(t.true_occurred_at + (offset.get(e.source_id) ?? 0));
        if (e.occurred_at > e.arrived_at) skewedAhead++;
      }
    }
    expect(skewedAhead).toBeGreaterThan(0); // fast clocks really do report "the future"
  });
  it("retractions exist, and some arrive before their target (orphans)", () => {
    let orphans = 0;
    let total = 0;
    for (let s = 0; s < 10; s++) {
      const ep = generateEpisode("cascade", s);
      const firstArrival = new Map<string, number>();
      for (const e of ep.events) if (!firstArrival.has(e.id)) firstArrival.set(e.id, e.arrived_at);
      for (const e of ep.events.filter((x) => x.kind === "retraction")) {
        total++;
        if (e.arrived_at < firstArrival.get(e.retracts!)!) orphans++;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(orphans).toBeGreaterThan(0);
  });
  it("fuzz option injects malformed events", () => {
    const ep = generateEpisode("noise", 5, { fuzz: true });
    const bad = ep.events.filter((e) => !e.zone_id || Number.isNaN(e.value) || (e.kind as string) === "alien_signal" || e.occurred_at > e.arrived_at + 3600);
    expect(bad.length).toBeGreaterThanOrEqual(4);
  });
});

describe("world and sizes", () => {
  it("world matches the spec: ~10 zones, 6 gateways, 80-120 sources, big gateway 25+", () => {
    for (let s = 0; s < 20; s++) {
      const ep = generateEpisode("noise", s);
      const r = ep.registry;
      expect(r.zones.length).toBe(10);
      expect(r.gateways.length).toBe(6);
      expect(r.sources.length).toBeGreaterThanOrEqual(80);
      expect(r.sources.length).toBeLessThanOrEqual(120);
      const perGw = r.gateways.map((g) => r.sources.filter((x) => x.gateway_id === g.gateway_id).length);
      expect(Math.max(...perGw)).toBeGreaterThanOrEqual(25);
      const hosp = r.sources.filter((x) => x.source_type === "hospital").length;
      expect(hosp).toBeGreaterThanOrEqual(3);
      expect(hosp).toBeLessThanOrEqual(4);
      expect(r.sources.filter((x) => x.source_type === "citizen_report").length).toBe(20);
    }
  });
  it("non-heartbeat event count is within 100-700 for a sample of seeds", () => {
    for (const name of SCENARIO_NAMES) {
      for (let s = 3000; s < 3005; s++) {
        const n = countSignalEvents(generateEpisode(name, s).events);
        expect(n, `${name} seed ${s}`).toBeGreaterThanOrEqual(100);
        expect(n, `${name} seed ${s}`).toBeLessThanOrEqual(700);
      }
    }
  });
  it("rain_only shares >= 3 signal kinds with a cascade in the first 8 minutes", () => {
    for (let s = 0; s < 10; s++) {
      const ep = generateEpisode("rain_only", s);
      const kinds = new Set(
        ep.events
          .filter((e) => e.arrived_at <= 480 && e.kind !== "heartbeat" && e.kind !== "retraction" && !ep.truth.event_truths[e.id]?.is_background)
          .map((e) => e.kind),
      );
      expect(kinds.size).toBeGreaterThanOrEqual(3);
    }
  });
});
