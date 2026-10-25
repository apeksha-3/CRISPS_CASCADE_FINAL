// engine/fallback.ts
// Safe fallback (R11). When a tick of the main engine throws, we still owe the
// duty officer an answer. We use the naive count-threshold baseline's
// probabilities and action, but never let the fallback raise the alarm level:
// the action is capped at the previous tick's action (a broken engine must not
// jump to ALERT/ESCALATE on its own). The tick is flagged fallback = true.

import { countThresholdBaseline } from "./baseline";
import { type Action, ACTIONS, type Event, type ProbabilityVector, type Seconds } from "./types";

export interface FallbackOutput {
  action: Action;
  probabilities: ProbabilityVector;
}

export function fallbackDecision(events: Event[], now: Seconds, previousAction: Action): FallbackOutput {
  const base = countThresholdBaseline(events, now);
  const capped = Math.min(ACTIONS.indexOf(base.action), ACTIONS.indexOf(previousAction));
  return { action: ACTIONS[capped], probabilities: base.probabilities };
}
