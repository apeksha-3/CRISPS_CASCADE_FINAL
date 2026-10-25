// server/prior-shift.ts
// The 100-episode prior-shift sequence, played IN ORDER with the same code as
// `npm run eval -- --split prior-shift --policy engine`:
//   engine              learns trust AND the base rates (+ CUSUM drift detector)
//   engine-static-prior learns trust only; the prior stays at config/priors.ts
// After each episode the truth is revealed to the learning loop (engine/learn.ts),
// and the dashboard gets one summary: truth, both Briers, and the prior the NEXT
// episode will start from.

import { makePolicy } from "../eval/baselines";
import { evalOrder, eventLabels, runEpisode } from "../eval/run";
import { groupOf, loadSplit } from "../sim/dataset";
import { PRIOR_SHIFT } from "../sim/params";
import type { Episode } from "../sim/truth";
import type { ProbabilityVector } from "../engine/types";

export interface ShiftSummary {
  episode: number; // 1-based
  episode_id: string;
  group: string;
  truth: string;
  brier: number; // adaptive engine
  brier_static: number; // static-prior engine, same episode
  prior_used: ProbabilityVector; // the prior this episode started from
  prior_next: ProbabilityVector; // after learning from this episode
  cusum_S: number;
  cusum_alarm: boolean; // fired after this episode
}

export interface ShiftRun {
  shift_at: number;
  length: number;
  episodes: Episode[];
  step(i: number): ShiftSummary;
}

export function priorShiftRun(): ShiftRun {
  const episodes = evalOrder("prior-shift", loadSplit("prior-shift"));
  const adaptive = makePolicy("engine", "prior-shift");
  const fixed = makePolicy("engine-static-prior", "prior-shift");
  return {
    shift_at: PRIOR_SHIFT.shift_at,
    length: episodes.length,
    episodes,
    step(i) {
      const ep = episodes[i];
      const a = runEpisode(adaptive, ep).result;
      const s = runEpisode(fixed, ep).result;
      const alarmsBefore = adaptive.learned!().drift.alarms.length;
      adaptive.afterEpisode!(ep.truth.hypothesis, eventLabels(ep)); // the outcome, revealed after the episode
      fixed.afterEpisode!(ep.truth.hypothesis, eventLabels(ep));
      const learned = adaptive.learned!();
      return {
        episode: i + 1,
        episode_id: ep.episode_id,
        group: groupOf(ep),
        truth: ep.truth.hypothesis,
        brier: a.brier,
        brier_static: s.brier,
        prior_used: a.prior,
        prior_next: adaptive.basePrior!(),
        cusum_S: learned.drift.S,
        cusum_alarm: learned.drift.alarms.length > alarmsBefore,
      };
    },
  };
}
