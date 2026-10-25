// tests/cluster.test.ts
// Near-duplicate clustering (R10): concave weight, surge protection, retraction.

import { describe, expect, it } from "vitest";
import { ClusterBook, clusterEvents, clusterWeight } from "../engine/cluster";
import { toUnit } from "../engine/grouping";
import { ce } from "./helpers";

describe("near-duplicate clustering", () => {
  it("5 events, same zone + kind within 3 min -> 1 cluster worth 1 + ln 5 = 2.6", () => {
    const evs = [0, 30, 60, 100, 170].map((dt, i) => ce({ arrived_at: 300 + dt, value: 60 + i }));
    const cs = clusterEvents(evs);
    expect(cs).toHaveLength(1);
    const u = toUnit(cs[0]);
    expect(u.n).toBe(5);
    expect(u.unit_type).toBe("near_duplicate");
    expect(u.weight).toBeCloseTo(1 + Math.log(5), 9);
    expect(u.weight).toBeCloseTo(2.61, 2);
    expect(clusterWeight(1)).toBe(1);
    expect(clusterWeight(50)).toBeCloseTo(4.91, 2); // 50 copies are worth ~5 events, not 50
  });

  it("different zone, kind, or more than 3 min after the first event -> separate clusters", () => {
    const evs = [
      ce({ arrived_at: 300 }),
      ce({ arrived_at: 310, zone_id: "z1" }),
      ce({ arrived_at: 320, kind: "drainage_anomaly", source_id: "drain0", source_type: "drainage_sensor" }),
      ce({ arrived_at: 300 + 181 }),
    ];
    expect(clusterEvents(evs)).toHaveLength(4);
  });

  it("surge protection: 30 distinct incidents (many sources, spread-out values) are NOT discounted", () => {
    const surge = Array.from({ length: 30 }, (_, i) => ce({ arrived_at: 300 + i * 5, source_id: `trf${i}`, value: 20 + 2.2 * i }));
    const u = toUnit(clusterEvents(surge)[0]);
    expect(u.surge).toBe(true);
    expect(u.weight).toBe(30);
    // the same 30 events as copies (one source, one value) ARE discounted
    const storm = Array.from({ length: 30 }, (_, i) => ce({ arrived_at: 300 + i * 5, value: 55 }));
    const d = toUnit(clusterEvents(storm)[0]);
    expect(d.surge).toBeUndefined();
    expect(d.weight).toBeCloseTo(1 + Math.log(30), 9);
  });

  it("retraction: retracting 1 of 5 drops the weight to 1 + ln 4 = 2.4; retracting all leaves n = 0, weight 0", () => {
    const book = new ClusterBook();
    const evs = [0, 20, 40, 60, 80].map((dt) => ce({ arrived_at: 300 + dt }));
    for (const e of evs) book.add(e);
    const c = book.retract(evs[2].id)!;
    expect(toUnit(c).n).toBe(4);
    expect(toUnit(c).weight).toBeCloseTo(1 + Math.log(4), 9);
    expect(toUnit(c).weight).toBeCloseTo(2.39, 2);
    for (const e of [evs[0], evs[1], evs[3], evs[4]]) book.retract(e.id);
    expect(toUnit(book.get(c.id)!).weight).toBe(0);
  });
});
