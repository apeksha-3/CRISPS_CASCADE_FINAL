// tests/tick.test.ts
// The tick runner end to end: fallback on errors, future isolation, quarantine.

import { describe, expect, it } from "vitest";
import { forwardFilter } from "../engine/filter";
import { Engine } from "../engine/tick";
import type { Event, TickRecord } from "../engine/types";
import { generateEpisode } from "../sim/episode";
import type { Episode } from "../sim/truth";

// Feed an episode to a fresh engine minute by minute (only new arrivals each tick).
function play(ep: Episode, engine = new Engine(ep.registry), extra: (t: number) => Event[] = () => []): TickRecord[] {
  const out: TickRecord[] = [];
  for (let t = 60; t <= ep.duration; t += 60) {
    const fresh = ep.events.filter((e) => e.arrived_at > t - 60 && e.arrived_at <= t);
    out.push(engine.tick([...fresh, ...extra(t)], t));
  }
  return out;
}

describe("tick runner", () => {
  it("runs a whole cascade episode without fallback, and probabilities sum to 1", () => {
    const recs = play(generateEpisode("cascade", 11));
    expect(recs.every((r) => !r.fallback)).toBe(true);
    for (const r of recs) expect(Object.values(r.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(recs.at(-1)!.probabilities.CASCADING_CRISIS).toBeGreaterThan(recs[0].probabilities.CASCADING_CRISIS);
  });

  it("is deterministic: same episode, same records", () => {
    const ep = generateEpisode("sensor_failure", 21, { variant: "lie" });
    expect(JSON.stringify(play(ep))).toBe(JSON.stringify(play(ep)));
  });

  it("falls back to the baseline when the filter throws, never crashing and never raising the action", () => {
    const ep = generateEpisode("cascade", 11);
    let calls = 0;
    const flaky: typeof forwardFilter = (...args) => {
      calls++;
      if (calls >= 20 && calls < 25) throw new Error("injected failure");
      return forwardFilter(...args);
    };
    const engine = new Engine(ep.registry, { filter: flaky });
    const recs = play(ep, engine);
    const fb = recs.filter((r) => r.fallback);
    expect(fb).toHaveLength(5);
    expect(engine.errors).toHaveLength(5);
    expect(engine.errors[0]).toMatch(/injected failure/);
    const i = recs.indexOf(fb[0]);
    const lvl = ["WATCH", "PREPARE", "ALERT", "ESCALATE"];
    for (let k = i; k < i + 5; k++) expect(lvl.indexOf(recs[k].action)).toBeLessThanOrEqual(lvl.indexOf(recs[k - 1].action));
    // the fallback uses the baseline's probability buckets
    expect(fb[0].probabilities.NOISE).toBeGreaterThan(0);
    expect(recs.at(-1)!.fallback).toBe(false); // recovers once the filter works again
  });

  it("future isolation (R8): events that arrive later never change the output at t", () => {
    const ep = generateEpisode("cascade", 11);
    const plain = play(ep);
    // at every tick, also hand the engine copies of events from the future
    const withFuture = play(ep, new Engine(ep.registry), (t) =>
      ep.events.filter((e) => e.arrived_at > t + 60).slice(0, 30).map((e) => ({ ...e, id: `future-${e.id}` })),
    );
    expect(withFuture.map((r) => [r.probabilities, r.action])).toEqual(plain.map((r) => [r.probabilities, r.action]));
    expect(withFuture.some((r) => r.quarantined.some((q) => /future/.test(q.reason)))).toBe(true);
  });

  it("quarantines malformed (fuzzed) events and counts unparseable ones, without crashing", () => {
    const ep = generateEpisode("noise", 5, { fuzz: true });
    const engine = new Engine(ep.registry);
    const recs = play(ep, engine, (t) => (t === 600 ? [null, "garbage", 7] : []) as unknown as Event[]);
    expect(recs.every((r) => !r.fallback)).toBe(true);
    const reasons = recs.flatMap((r) => r.quarantined.map((q) => q.reason));
    expect(reasons.length).toBeGreaterThanOrEqual(3); // NaN value, missing zone, unknown kind (the 4th is clock skew: allowed)
    expect(reasons.some((r) => /not a finite number/.test(r))).toBe(true);
    expect(reasons.some((r) => /unknown kind/.test(r))).toBe(true);
    expect(engine.unparsedTotal).toBe(3);
  });
});
