// tests/baseline.test.ts
// The count-threshold baseline: future isolation, dedupe, retractions (incl. orphans).

import { describe, expect, it } from "vitest";
import { cleanStream, countThresholdBaseline } from "../engine/baseline";
import type { Event } from "../engine/types";
import { generateEpisode } from "../sim/episode";

let n = 0;
function ev(arrived: number, extra: Partial<Event> = {}): Event {
  n++;
  return { id: `e${n}`, source_id: "s1", source_type: "traffic_sensor", zone_id: "z00", kind: "traffic_slowdown", occurred_at: arrived - 5, arrived_at: arrived, ...extra };
}

describe("count-threshold baseline", () => {
  it("only uses events with arrived_at <= t (adding future events changes nothing)", () => {
    const ep = generateEpisode("cascade", 11);
    for (const t of [300, 600, 900, 1200]) {
      const past = ep.events.filter((e) => e.arrived_at <= t);
      const all = [...ep.events, ...Array.from({ length: 200 }, (_, i) => ev(t + 1 + i))];
      expect(countThresholdBaseline(all, t)).toEqual(countThresholdBaseline(past, t));
    }
  });
  it("counts anomalies in the last 5 minutes only, ignoring heartbeats", () => {
    const events = [ev(10), ev(100), ev(400), ev(500), ev(550, { kind: "heartbeat" })];
    expect(countThresholdBaseline(events, 600).count).toBe(2); // 400 and 500
  });
  it("dedupes by id", () => {
    const a = ev(100);
    const copy = { ...a, arrived_at: 150 };
    expect(countThresholdBaseline([a, copy, ev(120)], 200).count).toBe(2);
  });
  it("applies a normal retraction", () => {
    const a = ev(100);
    const r = ev(130, { kind: "retraction", retracts: a.id });
    expect(countThresholdBaseline([a, r], 200).count).toBe(0);
  });
  it("orphan retraction: retraction first, target later => target treated as retracted", () => {
    const target = ev(200);
    const r = ev(100, { kind: "retraction", retracts: target.id });
    // before the target arrives, the retraction waits in the pending list
    const early = countThresholdBaseline([r, target], 150);
    expect(early.pending_retractions).toBe(1);
    expect(early.count).toBe(0);
    // once the target arrives it is already retracted, and nothing is pending
    const later = countThresholdBaseline([r, target, ev(210)], 250);
    expect(later.pending_retractions).toBe(0);
    expect(later.count).toBe(1); // only the other event
    expect(cleanStream([r, target], 250).events.map((e) => e.id)).not.toContain(target.id);
  });
  it("retraction of an unknown id never affects anything (discarded at episode end)", () => {
    const r = ev(100, { kind: "retraction", retracts: "never-arrives" });
    const out = countThresholdBaseline([r, ev(110)], 2700);
    expect(out.pending_retractions).toBe(1);
  });
  it("maps counts to actions and returns a 4-way probability vector summing to 1", () => {
    const many = Array.from({ length: 60 }, (_, i) => ev(1000 + i));
    const out = countThresholdBaseline(many, 1100);
    expect(out.action).toBe("ESCALATE");
    const s = Object.values(out.probabilities).reduce((a, b) => a + b, 0);
    expect(s).toBeCloseTo(1, 9);
    expect(countThresholdBaseline([], 60).action).toBe("WATCH");
  });
  it("does not crash on malformed (fuzzed) events", () => {
    const ep = generateEpisode("noise", 5, { fuzz: true });
    expect(() => countThresholdBaseline(ep.events, 1800)).not.toThrow();
  });
});
