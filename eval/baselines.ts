// eval/baselines.ts
// The policies the eval compares. Any real engine must beat the dumb ones to be worth anything.
//   always-watch        : never acts, always says "the base rates" (a climatology forecast)
//   count-threshold     : engine/baseline.ts (more anomalies in 5 min => bigger button)
//   engine              : engine/tick.ts with the DEV-TUNED likelihood tables, learning between episodes:
//                         trust always; base rates (+ CUSUM) only on the prior-shift SEQUENCE.
//                         Dev and test are benchmark buckets (28% cascades by construction),
//                         not a base-rate history, so the prior stays at config/priors.ts there.
//   engine-handset      : the same engine with the hand-set tables (config/likelihoods-handset.ts)
//   engine-static-prior : tuned tables, learns trust, prior fixed at config/priors.ts (every split)
//   engine-full-learning: tuned tables, learns trust AND base rates on every split (disclosure run)
//   engine-frozen       : tuned tables, no learning at all (every episode starts from the config)
// A policy only gets events (already cut to arrived_at <= now) and the public registry.
// Learning policies also get the revealed outcome AFTER each episode (afterEpisode).

import { HANDSET_TABLES } from "../config/likelihoods-handset";
import { PRIOR } from "../config/priors";
import { BASE_RATES } from "../config/transitions";
import { countThresholdBaseline } from "../engine/baseline";
import { currentPrior, initialLearnedState, type LearnedState, type LearnOptions, updateAfterEpisode } from "../engine/learn";
import { Engine, type EngineOptions } from "../engine/tick";
import type { EventLabels } from "../engine/trust";
import type { Action, Event, Hypothesis, ProbabilityVector, PublicRegistry, Seconds, TickRecord } from "../engine/types";
import type { LikelihoodTables } from "../config/likelihoods";
import type { Split } from "../sim/dataset";

export interface PolicyOutput {
  action: Action;
  probabilities: Record<Hypothesis, number>;
}

// Stateless policies implement decide(all visible events). A stateful policy
// implements start(registry) instead and is then fed only the NEW arrivals each tick.
export interface Policy {
  name: string;
  decide?(events: Event[], now: Seconds, registry: PublicRegistry): PolicyOutput;
  start?(registry: PublicRegistry): (newEvents: Event[], now: Seconds) => TickRecord;
  afterEpisode?(outcome: Hypothesis, labels?: EventLabels): void; // the truth, revealed once the episode is over
  basePrior?(): ProbabilityVector; // the prior the current episode started from
  learned?(): LearnedState;
}

export const alwaysWatch: Policy = {
  name: "always-watch",
  decide: () => ({ action: "WATCH", probabilities: { ...BASE_RATES } }),
};

export const countThreshold: Policy = {
  name: "count-threshold",
  decide: (events, now) => {
    const out = countThresholdBaseline(events, now);
    return { action: out.action, probabilities: out.probabilities };
  },
};

// The Bayesian engine plus the between-episode learning loop (engine/learn.ts).
// The engine itself never sees the outcome: it only gets trust + prior at start().
export function enginePolicy(name: string, learn: LearnOptions, tables?: LikelihoodTables, extra?: () => EngineOptions): Policy {
  let state = initialLearnedState();
  let engine: Engine | undefined;
  const prior = () => (learn.learnPrior ? currentPrior(state) : { ...PRIOR });
  return {
    name,
    start: (registry) => {
      engine = new Engine(registry, { prior: prior(), trust: state.trust, tables, ...extra?.() });
      return (newEvents, now) => engine!.tick(newEvents, now);
    },
    afterEpisode: (outcome, labels) => {
      state = updateAfterEpisode(state, outcome, engine?.sourceEvidence() ?? [], learn, labels);
    },
    basePrior: prior,
    learned: () => state,
  };
}

// What the engine learns on each split (see the header).
export const learningFor = (split: Split): LearnOptions => ({ learnPrior: split === "prior-shift", learnTrust: true });

// Factories: a fresh policy (fresh learning state) for every eval run.
export const POLICIES: Record<string, (split: Split) => Policy> = {
  "always-watch": () => alwaysWatch,
  "count-threshold": () => countThreshold,
  "engine-handset": (split) => enginePolicy("engine-handset", learningFor(split), HANDSET_TABLES),
  engine: (split) => enginePolicy("engine", learningFor(split)),
};

export const EXTRA_POLICIES: Record<string, (split: Split) => Policy> = {
  "engine-static-prior": () => enginePolicy("engine-static-prior", { learnPrior: false, learnTrust: true }),
  "engine-full-learning": () => enginePolicy("engine-full-learning", { learnPrior: true, learnTrust: true }),
  "engine-frozen": () => enginePolicy("engine-frozen", { learnPrior: false, learnTrust: false }),
};

export function makePolicy(name: string, split: Split = "dev"): Policy {
  const f = POLICIES[name] ?? EXTRA_POLICIES[name];
  if (!f) throw new Error(`unknown --policy ${name}. Options: ${[...Object.keys(POLICIES), ...Object.keys(EXTRA_POLICIES)].join(", ")}, all`);
  return f(split);
}
