// config/transitions.ts
// Transition matrix for the forward filter: P(hypothesis next minute | hypothesis now).
// Rows sum to 1.
//
// Each episode has ONE true situation, so the belief should mostly "stay put".
// Every minute we let a small share FORGET of it drift back to the base rates:
//   T[a][b] = (1 - FORGET) * (a == b ? 1 : 0) + FORGET * PRIOR[b]
// With no evidence at all, the belief slowly returns to the base rates (never
// to some arbitrary hypothesis), and an early mistake can be undone.
// Since Phase 4 the base rates are learned per episode, so the matrix is built
// from whatever prior the episode starts with (transitionsFor).

import { HYPOTHESES, type Hypothesis, type ProbabilityVector } from "../engine/types";
import { PRIOR } from "./priors";

export const FORGET = 0.02;

export type TransitionMatrix = Record<Hypothesis, Record<Hypothesis, number>>;

export function transitionsFor(prior: ProbabilityVector): TransitionMatrix {
  return Object.fromEntries(
    HYPOTHESES.map((a) => [a, Object.fromEntries(HYPOTHESES.map((b) => [b, (1 - FORGET) * (a === b ? 1 : 0) + FORGET * prior[b]]))]),
  ) as TransitionMatrix;
}

export const TRANSITIONS: TransitionMatrix = transitionsFor(PRIOR);

// Kept under its old name: always-WATCH and the twin-test metric use it.
export const BASE_RATES: Record<Hypothesis, number> = PRIOR;
