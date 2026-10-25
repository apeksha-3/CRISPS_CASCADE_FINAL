// engine/learn.ts
// Learning BETWEEN episodes (R4), pipeline steps 11-12.
//
// The eval harness (or a real control room, the morning after) calls
// updateAfterEpisode() once an episode is OVER and its outcome is known.
// The tick runner never sees the outcome: it only gets the learned state
// (trust per source + the prior) at the START of the next episode.
//
//   1. drift check (engine/drift.ts): was CASCADE more frequent than the prior said?
//      an alarm switches the prior to fast forgetting for a while
//   2. base rates (engine/priors.ts): decay the counts, count the true hypothesis
//   3. trust (engine/trust.ts): forget a little, then +1 alpha for every event of a
//      source that was right, +1 beta for every event that misled (a false alarm,
//      a lie, a rumor). Event labels are used when revealed, else the outcome alone.
//
// The outcome arrives as a plain Hypothesis label; this file never imports the
// simulator's GroundTruth type (engine/ never imports sim/, tested).

import { type DriftState, initialDriftState, updateDrift } from "./drift";
import { initialPriorState, type PriorState, priorVector, startFastForgetting, updatePrior } from "./priors";
import { type EventLabels, type SourceEvidence, type TrustState, updateTrust } from "./trust";
import type { Hypothesis, ProbabilityVector } from "./types";

export interface LearnedState {
  trust: TrustState;
  prior: PriorState;
  drift: DriftState;
  log: string[]; // one line per notable learning event (drift alarms)
}

export interface LearnOptions {
  learnPrior: boolean; // false = the static-prior engine (prior stays at config/priors.ts)
  learnTrust: boolean;
}

export const ALL_LEARNING: LearnOptions = { learnPrior: true, learnTrust: true };

export const initialLearnedState = (): LearnedState => ({ trust: {}, prior: initialPriorState(), drift: initialDriftState(), log: [] });

// The prior the next episode starts from.
export const currentPrior = (s: LearnedState): ProbabilityVector => priorVector(s.prior);

export function updateAfterEpisode(
  state: LearnedState,
  revealedOutcome: Hypothesis,
  evidence: SourceEvidence[],
  opts: LearnOptions = ALL_LEARNING,
  labels?: EventLabels,
): LearnedState {
  let { prior, drift } = state;
  const log = state.log.slice();
  if (opts.learnPrior) {
    const used = priorVector(prior);
    const d = updateDrift(drift, revealedOutcome, used.CASCADING_CRISIS);
    drift = d.state;
    if (d.alarm) {
      prior = startFastForgetting(prior);
      log.push(`episode ${drift.episode}: CUSUM drift alarm (cascades more frequent than the prior ${used.CASCADING_CRISIS.toFixed(2)}), faster forgetting for 10 episodes`);
    }
    prior = updatePrior(prior, revealedOutcome);
  } else {
    drift = { ...drift, episode: drift.episode + 1 };
  }
  const trust = opts.learnTrust ? updateTrust(state.trust, evidence, revealedOutcome, labels) : state.trust;
  return { trust, prior, drift, log };
}
