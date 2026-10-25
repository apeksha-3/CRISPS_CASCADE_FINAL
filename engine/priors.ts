// engine/priors.ts
// Learned base rates (R4): decayed episode counts with Dirichlet smoothing.
//
// Keep one count per hypothesis. After each episode (truth revealed):
//   1. multiply every count by the decay factor (0.95): old episodes fade
//   2. add 1 to the count of the true hypothesis
// The prior for the next episode is the counts divided by their total, with a
// floor of 2% per hypothesis (then renormalized) so nothing is ever ruled out.
//
// Why decay? With decay d the counts remember about 1 / (1 - d) = 20 recent
// episodes. If the world changes (monsoon season), the old regime fades out in
// a couple of dozen episodes instead of being averaged in forever.
// The starting counts are the configured base rates x 20 pseudo-episodes
// (the "Dirichlet smoothing": we start as if we had already seen 20 typical days).
//
// A CUSUM alarm (engine/drift.ts) switches the decay to 0.8 for 10 episodes:
// memory shrinks to ~5 episodes, so the prior catches up with the new regime fast.

import { PRIOR, PRIOR_KNOBS } from "../config/priors";
import { HYPOTHESES, type Hypothesis, type ProbabilityVector } from "./types";

export interface PriorState {
  counts: ProbabilityVector; // decayed counts (not probabilities)
  fast_left: number; // episodes of fast forgetting still to go (after a drift alarm)
}

export function initialPriorState(base: ProbabilityVector = PRIOR, k = PRIOR_KNOBS): PriorState {
  const counts = { ...base };
  for (const h of HYPOTHESES) counts[h] = base[h] * k.pseudo_count;
  return { counts, fast_left: 0 };
}

// The prior vector for the next episode: normalized counts, floored at 2%.
// Hypotheses below the floor are lifted to it; the others share what is left in
// proportion to their counts (repeat until nobody is below the floor).
export function priorVector(state: PriorState, k = PRIOR_KNOBS): ProbabilityVector {
  const total = HYPOTHESES.reduce((s, h) => s + state.counts[h], 0);
  const out = { ...state.counts };
  if (total <= 0) {
    for (const h of HYPOTHESES) out[h] = 1 / HYPOTHESES.length;
    return out;
  }
  const floored = new Set<string>();
  for (let round = 0; round < HYPOTHESES.length; round++) {
    const free = HYPOTHESES.filter((h) => !floored.has(h));
    const freeCount = free.reduce((s, h) => s + state.counts[h], 0);
    const left = 1 - k.floor * floored.size;
    for (const h of HYPOTHESES) out[h] = floored.has(h) ? k.floor : (left * state.counts[h]) / freeCount;
    const low = free.filter((h) => out[h] < k.floor);
    if (low.length === 0) break;
    for (const h of low) floored.add(h);
  }
  return out;
}

// After an episode: decay (fast if a drift alarm is active), then count the truth.
export function updatePrior(state: PriorState, truth: Hypothesis, k = PRIOR_KNOBS): PriorState {
  const fast = state.fast_left > 0;
  const d = fast ? k.fast_decay : k.decay;
  const counts = { ...state.counts };
  for (const h of HYPOTHESES) counts[h] *= d;
  counts[truth] += 1;
  return { counts, fast_left: fast ? state.fast_left - 1 : 0 };
}

// A drift alarm: forget fast for the next `fast_episodes` episodes.
export function startFastForgetting(state: PriorState, k = PRIOR_KNOBS): PriorState {
  return { ...state, fast_left: k.fast_episodes };
}
