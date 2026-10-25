// tests/grouping.test.ts
// Common-cause grouping: the gateway perfect-correlation detector and rumor narratives.

import { describe, expect, it } from "vitest";
import { GATEWAY_CORRELATED, LIKELIHOODS, RUMOR_CAPPED } from "../config/likelihoods";
import { TRUST_PRIORS } from "../config/trust-priors";
import { betaMean } from "../engine/trust";

const CITIZEN_TRUST = betaMean(TRUST_PRIORS.citizen_report); // a lone citizen channel, before any learning
import { ClusterBook } from "../engine/cluster";
import { unitLogLikelihood } from "../engine/filter";
import { detectGatewayGroups, gatewaySensorCounts, isCorroborated, toUnit } from "../engine/grouping";
import { Engine } from "../engine/tick";
import type { Event } from "../engine/types";
import { ce, ev, REGISTRY } from "./helpers";

const SENSORS = [
  { source_id: "rain0", source_type: "rain_gauge", kind: "rain_heavy" },
  { source_id: "drain0", source_type: "drainage_sensor", kind: "drainage_anomaly" },
  { source_id: "traf0", source_type: "traffic_sensor", kind: "traffic_slowdown" },
] as const;
// n anomalies from gw0's sensors in one minute; value(i) decides whether they are identical
function burst(n: number, value: (i: number) => number, t = 600): Event[] {
  return Array.from({ length: n }, (_, i) => ev({ ...SENSORS[i % 3], gateway_id: "gw0", zone_id: "z0", arrived_at: t - 50 + i, value: value(i), reported_severity: 0.9 }));
}
const counts = gatewaySensorCounts(REGISTRY);

describe("gateway perfect-correlation detector", () => {
  it("10 identical values from one gateway -> 1 group (one evidence unit flagged gateway_correlated)", () => {
    const evs = burst(10, () => 99.9);
    const groups = detectGatewayGroups(evs, counts, [], 600);
    expect(groups).toHaveLength(1);
    expect(groups[0].ids).toHaveLength(10);
    const book = new ClusterBook();
    const c = book.addGatewayGroup("gw0", 99.9, evs.map((e) => ce({ ...e })));
    const u = toUnit(c);
    expect(u.unit_type).toBe("gateway_correlated");
    expect(u.weight).toBe(1);
    const row = unitLogLikelihood(u);
    expect(row).toEqual(GATEWAY_CORRELATED); // high SENSOR_FAILURE, strongly against CASCADE
    expect(row.SENSOR_FAILURE).toBeGreaterThan(1);
    expect(row.CASCADING_CRISIS).toBeLessThan(0);
  });

  it("10 different values from one gateway -> NOT correlated (normal operation)", () => {
    expect(detectGatewayGroups(burst(10, (i) => 40 + 3.7 * i), counts, [], 600)).toEqual([]);
  });

  it("fewer than 5 identical values, or a gateway with under 3 sensors, is not flagged", () => {
    expect(detectGatewayGroups(burst(4, () => 99.9), counts, [], 600)).toEqual([]);
    expect(detectGatewayGroups(burst(10, () => 99.9), new Map([["gw0", 2]]), [], 600)).toEqual([]);
  });

  it("in the engine: a lying burst raises P(sensor_failure); the same events with varied values do not", () => {
    // t = 120: every source still counts as live, so no coverage widening blurs the comparison
    const lie = new Engine(REGISTRY).tick(burst(10, () => 99.9, 120), 120);
    const real = new Engine(REGISTRY).tick(burst(10, (i) => 40 + 3.7 * i, 120), 120);
    expect(lie.probabilities.SENSOR_FAILURE).toBeGreaterThan(0.5);
    expect(lie.probabilities.CASCADING_CRISIS).toBeLessThan(real.probabilities.CASCADING_CRISIS);
    expect(real.probabilities.SENSOR_FAILURE).toBeLessThan(0.2);
    expect(lie.evidence_units).toBe(1);
    expect(lie.explanation.top_evidence[0].description).toMatch(/gateway gw0: 10 sensors report the identical value 99.9/);
  });
});

describe("narrative clusters (rumor cap)", () => {
  // 8 citizen reports of one story in z1 (adjusted times 590..695 s)
  const reports = Array.from({ length: 8 }, (_, i) =>
    ce({ arrived_at: 600 + 15 * i, source_id: "cit0", source_type: "citizen_report", kind: "citizen_report", zone_id: "z1", narrative_id: "n-bridge", reported_severity: 0.9 }),
  );
  const drainage = ce({ arrived_at: 700, source_id: "drain0", source_type: "drainage_sensor", kind: "drainage_anomaly", zone_id: "z1", reported_severity: 0.8 });

  it("8 reports sharing a narrative_id, no physical corroboration -> 1 cluster capped at one low-trust event", () => {
    const book = new ClusterBook();
    for (const r of reports) book.add(r);
    expect(book.all()).toHaveLength(1);
    const c = book.all()[0];
    expect(isCorroborated(c, reports, new Set())).toBe(false);
    const u = toUnit(c);
    expect(u.unit_type).toBe("narrative");
    expect(u.n).toBe(8);
    expect(u.weight).toBe(1);
    const row = unitLogLikelihood(u);
    expect(row.ISOLATED_INCIDENT).toBeCloseTo(CITIZEN_TRUST * RUMOR_CAPPED.ISOLATED_INCIDENT, 9);
    expect(row.CASCADING_CRISIS).toBeCloseTo(CITIZEN_TRUST * RUMOR_CAPPED.CASCADING_CRISIS, 9);
    expect(Math.abs(row.CASCADING_CRISIS)).toBeLessThan(0.1); // one weak unit at most
  });

  it("the same 8 reports + 1 drainage anomaly in the same zone -> full cluster weight 1 + ln 8", () => {
    const book = new ClusterBook();
    for (const r of reports) book.add(r);
    const c = book.all()[0];
    expect(isCorroborated(c, [...reports, drainage], new Set())).toBe(true);
    c.corroborated = true;
    const u = toUnit(c);
    expect(u.weight).toBeCloseTo(1 + Math.log(8), 9);
    const row = unitLogLikelihood(u);
    expect(row.ISOLATED_INCIDENT).toBeCloseTo(u.weight * CITIZEN_TRUST * LIKELIHOODS.citizen_report!.alone.ISOLATED_INCIDENT, 9);
  });

  it("corroboration needs the same zone, a clear anomaly, and +/- 5 min", () => {
    const c = (() => {
      const b = new ClusterBook();
      for (const r of reports) b.add(r);
      return b.all()[0];
    })();
    expect(isCorroborated(c, [{ ...drainage, zone_id: "z0" }], new Set())).toBe(false);
    expect(isCorroborated(c, [{ ...drainage, reported_severity: 0.4 }], new Set())).toBe(false);
    expect(isCorroborated(c, [{ ...drainage, adjusted_occurred_at: 695 + 301 }], new Set())).toBe(false);
    expect(isCorroborated(c, [{ ...drainage, adjusted_occurred_at: 695 + 299 }], new Set())).toBe(true);
  });

  it("in the engine: a 30-report rumor moves the belief far less than 30 independent reports would", () => {
    const wave = Array.from({ length: 30 }, (_, i) => ev({ arrived_at: 560 + i, source_id: "cit0", source_type: "citizen_report", kind: "citizen_report", zone_id: "z1", narrative_id: "n-rumor", reported_severity: 0.9 }));
    const capped = new Engine(REGISTRY).tick(wave, 600);
    const independent = new Engine(REGISTRY).tick(wave.map((e, i) => ({ ...e, narrative_id: `n-${i}`, zone_id: i % 2 ? "z0" : "z1" })), 600);
    const quiet = new Engine(REGISTRY).tick([], 600);
    // how far each moved the belief: sum over hypotheses of |p - p with no evidence|
    const moved = (r: typeof quiet) => Object.keys(r.probabilities).reduce((s, h) => s + Math.abs(r.probabilities[h as keyof typeof r.probabilities] - quiet.probabilities[h as keyof typeof r.probabilities]), 0);
    expect(capped.probabilities.ISOLATED_INCIDENT).toBeLessThan(0.25);
    expect(moved(independent)).toBeGreaterThan(3 * moved(capped));
  });
});
