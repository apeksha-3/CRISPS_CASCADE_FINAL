// tests/decide.test.ts
// Expected cost picks the cheapest action; hysteresis stops flip-flopping.

import { describe, expect, it } from "vitest";
import { decide, type DecisionState, expectedCosts, initialDecisionState, optimalAction } from "../engine/decide";
import type { Action, ProbabilityVector } from "../engine/types";

const pv = (n: number, s: number, i: number, c: number): ProbabilityVector => ({ NOISE: n, SENSOR_FAILURE: s, ISOLATED_INCIDENT: i, CASCADING_CRISIS: c });
const CALM = pv(0.97, 0.02, 0.01, 0);
const ALERTY = pv(0.4, 0.05, 0.05, 0.5); // ALERT is cheapest here (checked below)

function run(seq: ProbabilityVector[], start: DecisionState = initialDecisionState()): Action[] {
  let st = start;
  return seq.map((p) => {
    const d = decide(p, st);
    st = d.state;
    return d.action;
  });
}

describe("expected cost", () => {
  it("computes sum_H P(H) * cost(action, H) and picks the minimum", () => {
    const p = pv(0.4, 0.05, 0.05, 0.5);
    const ec = expectedCosts(p);
    // WATCH = 0.05*1 + 0.5*50 = 25.05; PREPARE = 0.45*1 + 0.05*2 + 0.5*15 = 8.05
    // ALERT = 0.45*6 + 0.05*4 + 0.5*5 = 5.4; ESCALATE = 0.45*25 + 0.05*20 = 12.25
    expect(ec.WATCH).toBeCloseTo(25.05, 9);
    expect(ec.PREPARE).toBeCloseTo(8.05, 9);
    expect(ec.ALERT).toBeCloseTo(5.4, 9);
    expect(ec.ESCALATE).toBeCloseTo(12.25, 9);
    expect(optimalAction(ec)).toBe("ALERT");
    expect(optimalAction(expectedCosts(CALM))).toBe("WATCH");
    expect(optimalAction(expectedCosts(pv(0.05, 0, 0.05, 0.9)))).toBe("ESCALATE");
  });
});

describe("hysteresis", () => {
  it("needs 2 consecutive ticks above before going up", () => {
    expect(run([ALERTY, CALM, ALERTY, CALM, ALERTY, CALM])).toEqual(["WATCH", "WATCH", "WATCH", "WATCH", "WATCH", "WATCH"]);
    expect(run([ALERTY, ALERTY])).toEqual(["WATCH", "ALERT"]);
  });
  it("needs 4 consecutive ticks below (and a low P(cascade)) before stepping down ONE level", () => {
    const up = run([ALERTY, ALERTY, ALERTY, ALERTY, ALERTY, CALM, CALM, CALM, CALM, CALM]);
    expect(up.slice(0, 5)).toEqual(["WATCH", "ALERT", "ALERT", "ALERT", "ALERT"]);
    expect(up.slice(5)).toEqual(["ALERT", "ALERT", "ALERT", "PREPARE", "PREPARE"]); // 4th calm tick: one step down
    // P(cascade) still above 0.3: no step down from ALERT even after many lower-optimal ticks
    const lukewarm = pv(0.6, 0.05, 0.05, 0.3); // PREPARE is optimal here, but P(cascade) = 0.3 is not below 0.3
    expect(optimalAction(expectedCosts(lukewarm))).toBe("PREPARE");
    const st = { ...initialDecisionState(), current: "ALERT" as Action, ticks_at_current: 10 };
    expect(run(Array(8).fill(lukewarm), st).every((a) => a === "ALERT")).toBe(true);
  });
  it("an alternating signal produces no flip-flops", () => {
    const actions = run(Array.from({ length: 20 }, (_, i) => (i % 2 ? CALM : ALERTY)));
    expect(new Set(actions)).toEqual(new Set(["WATCH"]));
  });
  it("minimum dwell: after a change, stays at least 3 ticks", () => {
    const st = { ...initialDecisionState(), current: "PREPARE" as Action, ticks_at_current: 1 };
    // optimal is ALERT every tick, but we only just arrived at PREPARE
    expect(run([ALERTY, ALERTY, ALERTY], st)).toEqual(["PREPARE", "PREPARE", "ALERT"]);
  });
  it("fast commit: P(cascade) > 0.9 jumps straight to ESCALATE, ignoring dwell and streaks", () => {
    const st = { ...initialDecisionState(), current: "WATCH" as Action, ticks_at_current: 0 };
    expect(run([pv(0.05, 0, 0.04, 0.91)], st)).toEqual(["ESCALATE"]);
    expect(run([pv(0.1, 0, 0.0, 0.9)], st)).toEqual(["WATCH"]); // exactly 0.9 is not above 0.9
  });
});
