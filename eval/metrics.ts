// eval/metrics.ts
// Scoring functions. The evaluator may read ground truth; the policy may not.

import { COST_MATRIX, WATCH_CASCADE_COST_PER_MINUTE } from "../config/costs";
import { type Action, ACTIONS, HYPOTHESES, type Hypothesis } from "../engine/types";

// Brier score for 4 classes: sum over hypotheses of (predicted - actual)^2,
// where actual is 1 for the true hypothesis and 0 for the others.
// 0 = perfect, 2 = fully confident and wrong. Rewards honest probabilities.
export function brierScore(p: Record<Hypothesis, number>, truth: Hypothesis): number {
  return HYPOTHESES.reduce((s, h) => s + (p[h] - (h === truth ? 1 : 0)) ** 2, 0);
}

// Log-loss: -ln(probability given to what really happened). Punishes
// confident mistakes very hard (p = 0.01 on the truth costs 4.6).
// We floor p at 1e-6 so one zero does not give infinity.
export const LOG_LOSS_FLOOR = 1e-6;
export function logLoss(p: Record<Hypothesis, number>, truth: Hypothesis): number {
  return -Math.log(Math.max(LOG_LOSS_FLOOR, p[truth]));
}

// Cost of one tick: the cost-matrix cell for (action, true hypothesis).
// Under a cascade, WATCH also gets worse every minute after the true onset
// (lost lead time = damage that could have been avoided).
export function tickCost(action: Action, truth: Hypothesis, minutesSinceOnset: number): number {
  let c = COST_MATRIX[action][truth];
  if (action === "WATCH" && truth === "CASCADING_CRISIS") c += WATCH_CASCADE_COST_PER_MINUTE * Math.max(0, minutesSinceOnset);
  return c;
}

export const level = (a: Action) => ACTIONS.indexOf(a);

// Flip-flops: how often the action changes DIRECTION.
// WATCH -> ALERT -> WATCH is one reversal; WATCH -> PREPARE -> ALERT is none.
export function flipFlops(actions: Action[]): number {
  let flips = 0;
  let lastDir = 0;
  for (let i = 1; i < actions.length; i++) {
    const d = Math.sign(level(actions[i]) - level(actions[i - 1]));
    if (d === 0) continue;
    if (lastDir !== 0 && d !== lastDir) flips++;
    lastDir = d;
  }
  return flips;
}

// Squared distance between a probability vector and a reference (e.g. base rates).
export function sqDistance(p: Record<Hypothesis, number>, q: Record<Hypothesis, number>): number {
  return HYPOTHESES.reduce((s, h) => s + (p[h] - q[h]) ** 2, 0);
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
