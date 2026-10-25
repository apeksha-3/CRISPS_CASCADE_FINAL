// config/costs.ts
// Cost matrix (R2): cost of taking ACTION when the TRUE situation is HYPOTHESIS.
// Units are arbitrary "damage points". Hand-set, tune later.
// Read a row as: "if I press this button, how bad is it under each truth?"

import type { Action, Hypothesis } from "../engine/types";

export const COST_MATRIX: Record<Action, Record<Hypothesis, number>> = {
  //          NOISE  SENSOR_FAIL  ISOLATED  CASCADE
  WATCH:    { NOISE: 0,  SENSOR_FAILURE: 0,  ISOLATED_INCIDENT: 1,  CASCADING_CRISIS: 50 },
  PREPARE:  { NOISE: 1,  SENSOR_FAILURE: 1,  ISOLATED_INCIDENT: 2,  CASCADING_CRISIS: 15 },
  ALERT:    { NOISE: 6,  SENSOR_FAILURE: 6,  ISOLATED_INCIDENT: 4,  CASCADING_CRISIS: 5 },
  ESCALATE: { NOISE: 25, SENSOR_FAILURE: 25, ISOLATED_INCIDENT: 20, CASCADING_CRISIS: 0 },
};

// Value of lead time: WATCH under CASCADE gets worse every minute we wait
// after the estimated onset. Placeholder, hand-set, tune later (Phase 2).
export const WATCH_CASCADE_COST_PER_MINUTE = 5;
