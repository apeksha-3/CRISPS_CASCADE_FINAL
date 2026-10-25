// config/priors.ts
// Base rates: how often each situation happens, before we see any evidence.
// This is the engine's starting belief, and what calibration widening falls
// back to when sensors go dark. Hand-set. Since Phase 4 these are only the
// STARTING point: engine/priors.ts learns them across episodes (R4).

import type { ProbabilityVector } from "../engine/types";

export const PRIOR: ProbabilityVector = {
  NOISE: 0.55,
  SENSOR_FAILURE: 0.15,
  ISOLATED_INCIDENT: 0.2,
  CASCADING_CRISIS: 0.1,
};

// Base-rate learning (engine/priors.ts) and drift detection (engine/drift.ts).
export const PRIOR_KNOBS = {
  // Each episode, old counts are multiplied by this before the new one is added.
  // At 0.95 the counts settle at a total of 1 / (1 - 0.95) = 20 "remembered" episodes.
  decay: 0.95,
  // The starting counts = PRIOR x this many pseudo-episodes (the settled total, 20).
  pseudo_count: 20,
  floor: 0.02, // no hypothesis is ever below 2% a priori
  // After a CUSUM alarm: forget faster for a while.
  fast_decay: 0.8,
  fast_episodes: 10,
};

export const DRIFT_KNOBS = {
  // CUSUM on residual = 1(truth is CASCADE) - prior(CASCADE):
  //   S = max(0, S + residual - slack); alarm when S > threshold, then S = 0.
  slack: 0.05,
  threshold: 3.0,
};
