// tests/metrics.test.ts
// Scoring functions on tiny hand-made examples.

import { describe, expect, it } from "vitest";
import { brierScore, flipFlops, logLoss, tickCost } from "../eval/metrics";
import { runEpisode } from "../eval/run";
import type { Policy } from "../eval/baselines";
import type { Hypothesis } from "../engine/types";
import type { Episode } from "../sim/truth";

const P = (n: number, s: number, i: number, c: number): Record<Hypothesis, number> => ({
  NOISE: n, SENSOR_FAILURE: s, ISOLATED_INCIDENT: i, CASCADING_CRISIS: c,
});

describe("Brier and log-loss", () => {
  it("perfect, uniform and confidently-wrong forecasts", () => {
    expect(brierScore(P(1, 0, 0, 0), "NOISE")).toBe(0);
    expect(brierScore(P(0.25, 0.25, 0.25, 0.25), "NOISE")).toBeCloseTo(0.75, 12); // 0.5625 + 3*0.0625
    expect(brierScore(P(0, 0, 0, 1), "NOISE")).toBe(2);
    expect(logLoss(P(0.5, 0.5, 0, 0), "NOISE")).toBeCloseTo(Math.log(2), 12);
    expect(logLoss(P(0, 1, 0, 0), "NOISE")).toBeCloseTo(-Math.log(1e-6), 9); // floored, not infinite
  });
  it("Brier by hand: p = (0.6, 0.1, 0.1, 0.2), truth CASCADE", () => {
    // (0.6)^2 + (0.1)^2 + (0.1)^2 + (0.2 - 1)^2 = 0.36 + 0.01 + 0.01 + 0.64 = 1.02
    expect(brierScore(P(0.6, 0.1, 0.1, 0.2), "CASCADING_CRISIS")).toBeCloseTo(1.02, 12);
  });
});

describe("cost", () => {
  it("uses the matrix, and WATCH under CASCADE grows 5 per minute after onset", () => {
    expect(tickCost("ALERT", "NOISE", 0)).toBe(6);
    expect(tickCost("ESCALATE", "CASCADING_CRISIS", 10)).toBe(0);
    expect(tickCost("WATCH", "CASCADING_CRISIS", -3)).toBe(50); // before onset: just the base cost
    expect(tickCost("WATCH", "CASCADING_CRISIS", 4)).toBe(70);
    expect(tickCost("WATCH", "NOISE", 4)).toBe(0);
  });
  it("per-episode cost is normalized by episode length in ticks", () => {
    const ep = (minutes: number, hyp: Hypothesis): Episode =>
      ({
        episode_id: `e${minutes}`, seed: 0, type: "noise", duration: minutes * 60,
        registry: { zones: [], gateways: [], sources: [] }, events: [],
        truth: { hypothesis: hyp, episode_type: "noise", stage_times: {}, stages: [], build_attempt: 0, cutouts: [], failed_gateways: [], surge: false, drifting_sources: [], weather: "normal", sources: [], event_truths: {} },
      }) as Episode;
    const alwaysAlert: Policy = { name: "a", decide: () => ({ action: "ALERT", probabilities: P(1, 0, 0, 0) }) };
    const short = runEpisode(alwaysAlert, ep(10, "NOISE")).result;
    const long = runEpisode(alwaysAlert, ep(40, "NOISE")).result;
    expect(short.cost_total).toBe(60);
    expect(long.cost_total).toBe(240);
    expect(short.cost_per_tick).toBe(6);
    expect(long.cost_per_tick).toBe(6);
    expect(short.any_alert).toBe(true);
  });
});

describe("flip-flops", () => {
  it("counts direction reversals only", () => {
    expect(flipFlops(["WATCH", "PREPARE", "ALERT", "ESCALATE"])).toBe(0);
    expect(flipFlops(["WATCH", "ALERT", "WATCH"])).toBe(1);
    expect(flipFlops(["ESCALATE", "WATCH", "ESCALATE"])).toBe(1);
    expect(flipFlops(["WATCH", "ALERT", "ALERT", "WATCH", "PREPARE", "WATCH"])).toBe(3);
  });
});
