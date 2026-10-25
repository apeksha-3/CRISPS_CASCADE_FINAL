// engine/drift.ts
// CUSUM drift detector (R4): notices when cascades start happening more often
// than the prior expects (e.g. the monsoon season starts).
//
// After each episode (truth revealed):
//   residual = 1 if the truth was CASCADE else 0,  minus  the prior P(CASCADE) we used
// A residual is "how surprised we were". On average it is 0 if the prior is right.
// CUSUM adds up surprises, minus a small slack k, and never goes below 0:
//   S = max(0, S + residual - k)
// Normal luck makes S wobble near 0. A real shift adds a little every episode, so S
// climbs steadily; when S > threshold (3.0) we raise an alarm, reset S to 0, and
// engine/priors.ts forgets faster for 10 episodes.
// It only watches the CASCADE rate going UP (the costly direction). A one-sided
// check is the classic CUSUM; a mirror image could watch for it going down.

import { DRIFT_KNOBS } from "../config/priors";
import type { Hypothesis } from "./types";

export interface DriftState {
  S: number;
  episode: number; // episodes seen so far
  alarms: number[]; // 1-based episode numbers where an alarm fired
}

export const initialDriftState = (): DriftState => ({ S: 0, episode: 0, alarms: [] });

export function updateDrift(state: DriftState, truth: Hypothesis, priorCascade: number, k = DRIFT_KNOBS): { state: DriftState; alarm: boolean } {
  const residual = (truth === "CASCADING_CRISIS" ? 1 : 0) - priorCascade;
  const S = Math.max(0, state.S + residual - k.slack);
  const episode = state.episode + 1;
  if (S > k.threshold) return { state: { S: 0, episode, alarms: [...state.alarms, episode] }, alarm: true };
  return { state: { S, episode, alarms: state.alarms }, alarm: false };
}
