// engine/decide.ts
// Pick an action (R2), then smooth it with hysteresis (R6).
//
// Expected cost of an action = sum over hypotheses of P(H) * cost(action, H),
// using the cost matrix in config/costs.ts. The cheapest one is "optimal".
//
// Hysteresis turns the jumpy optimal action into a steady recommendation:
//   UP:   the optimal action must be above the current one for 2 ticks in a row.
//         We then move up to the level both ticks agreed on (the lower of the two).
//   DOWN: the optimal action must be below the current one for 4 ticks in a row
//         AND P(cascade) under the step's threshold (ALERT->PREPARE 0.3,
//         PREPARE->WATCH 0.15). We step down ONE level at a time.
//   DWELL: after any change, stay at least 3 ticks before changing again.
//   FAST COMMIT: if P(cascade) > 0.9, jump straight to ESCALATE, ignoring all of the above.
//
// One-step lookahead (R2 "act now vs wait one more minute", Phase 3). The forecast
// (engine/forecast.ts) says what the NEXT stage of the chain would do to the belief:
// with chance q it arrives (belief -> ifArrives), otherwise ifNot.
//   act now : cost(opt, now) + E[cost(opt, next)]          (an upgrade is sticky: dwell)
//   wait    : cost(current, now) + E[min over a of cost(a, next)]   (free to choose next tick)
// If waiting is cheaper by more than a margin, the upgrade is deferred one tick
// (this tick neither counts toward nor breaks the 2-tick streak). Never two
// deferrals in a row (knob lookahead_max_defer_ticks = 1), so each deferral costs
// one tick and the streak resumes. Typical case: a rain-only day where the
// hospital window is about to close empty.
// Anticipation: if the optimal action now is NOT above the current one, but the
// expected belief next tick makes a higher action optimal, this tick counts as the
// first of the 2 "above" ticks. The second tick must still be really above.
// Point estimates, no Monte Carlo sampling.
// Pure function: the state goes in and a new state comes out.

import { COST_MATRIX } from "../config/costs";
import { KNOBS } from "../config/knobs";
import type { Lookahead } from "./forecast";
import { type Action, ACTIONS, HYPOTHESES, type ProbabilityVector } from "./types";

export interface DecisionState {
  current: Action;
  ticks_at_current: number; // ticks already spent at `current`
  ticks_above: number; // consecutive ticks the optimal action was higher
  ticks_below: number; // consecutive ticks the optimal action was lower
  above_floor: number; // lowest optimal level seen during the current "above" streak
  deferred_ticks?: number; // consecutive ticks the lookahead deferred an upgrade
}

export interface DecisionConfig {
  costs: Record<Action, Record<string, number>>;
  knobs: typeof KNOBS;
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = { costs: COST_MATRIX, knobs: KNOBS };

// Start at WATCH, already "dwelled", so the first ticks may move.
export function initialDecisionState(knobs = KNOBS): DecisionState {
  return { current: "WATCH", ticks_at_current: knobs.min_dwell_ticks, ticks_above: 0, ticks_below: 0, above_floor: Infinity };
}

export function expectedCosts(posterior: ProbabilityVector, costs = COST_MATRIX): Record<Action, number> {
  const out = {} as Record<Action, number>;
  for (const a of ACTIONS) out[a] = HYPOTHESES.reduce((s, h) => s + posterior[h] * costs[a][h], 0);
  return out;
}

export function optimalAction(ec: Record<Action, number>): Action {
  return ACTIONS.reduce((best, a) => (ec[a] < ec[best] ? a : best)); // ties go to the cheaper (lower) action
}

const lvl = (a: Action) => ACTIONS.indexOf(a);

export interface Decision {
  action: Action;
  expected_cost: number;
  expected_costs: Record<Action, number>;
  optimal: Action; // before hysteresis
  state: DecisionState;
  lookahead: "none" | "deferred" | "anticipated";
}

const minCost = (ec: Record<Action, number>) => Math.min(...ACTIONS.map((a) => ec[a]));

// Expected cost over the two next-tick branches.
function nextTick(la: Lookahead, costs: DecisionConfig["costs"], f: (ec: Record<Action, number>) => number): number {
  const c = costs as Record<Action, Record<keyof ProbabilityVector, number>>;
  return la.q * f(expectedCosts(la.ifArrives, c)) + (1 - la.q) * f(expectedCosts(la.ifNot, c));
}

// Is waiting one tick clearly cheaper than upgrading to `opt` now?
export function waitIsCheaper(ec: Record<Action, number>, current: Action, opt: Action, la: Lookahead, config: DecisionConfig = DEFAULT_DECISION_CONFIG): boolean {
  const act = ec[opt] + nextTick(la, config.costs, (e) => e[opt]);
  const wait = ec[current] + nextTick(la, config.costs, minCost);
  return wait + config.knobs.lookahead_margin < act;
}

// The action that is optimal for the EXPECTED belief next tick.
export function anticipatedAction(la: Lookahead, config: DecisionConfig = DEFAULT_DECISION_CONFIG): Action {
  const p = {} as ProbabilityVector;
  for (const h of HYPOTHESES) p[h] = la.q * la.ifArrives[h] + (1 - la.q) * la.ifNot[h];
  return optimalAction(expectedCosts(p, config.costs as Record<Action, Record<keyof ProbabilityVector, number>>));
}

export function decide(posterior: ProbabilityVector, state: DecisionState, config: DecisionConfig = DEFAULT_DECISION_CONFIG, la?: Lookahead): Decision {
  const k = config.knobs;
  const ec = expectedCosts(posterior, config.costs as Record<Action, Record<keyof ProbabilityVector, number>>);
  const optimal = optimalAction(ec);
  const pc = posterior.CASCADING_CRISIS;
  const cur = lvl(state.current);
  let opt = lvl(optimal);
  let mode: Decision["lookahead"] = "none";
  if (la && pc <= k.fast_commit_p_cascade) {
    if (opt > cur && (state.deferred_ticks ?? 0) < k.lookahead_max_defer_ticks && waitIsCheaper(ec, state.current, optimal, la, config)) {
      // defer: this tick neither counts toward nor breaks the "above" streak
      return hold(state, ec, optimal, "deferred");
    }
    if (opt <= cur && k.lookahead_anticipate && state.ticks_above === 0) {
      const ant = lvl(anticipatedAction(la, config));
      if (ant > cur) {
        opt = ant;
        mode = "anticipated";
      }
    }
  }

  const s: DecisionState = { ...state, deferred_ticks: 0 };
  s.ticks_above = opt > cur ? s.ticks_above + 1 : 0;
  s.ticks_below = opt < cur ? s.ticks_below + 1 : 0;
  s.above_floor = opt > cur ? Math.min(s.above_floor, opt) : Infinity;

  let next = cur;
  const dwelled = s.ticks_at_current >= k.min_dwell_ticks;
  if (pc > k.fast_commit_p_cascade) {
    next = lvl("ESCALATE");
  } else if (dwelled && s.ticks_above >= k.escalate_consecutive_ticks) {
    next = s.above_floor;
  } else if (dwelled && s.ticks_below >= k.deescalate_consecutive_ticks && pc < k.deescalate_max_p_cascade[state.current]) {
    next = cur - 1;
  }

  if (next !== cur) {
    s.current = ACTIONS[next];
    s.ticks_at_current = 1;
    s.ticks_above = 0;
    s.ticks_below = 0;
    s.above_floor = Infinity;
  } else {
    s.ticks_at_current += 1;
  }
  return { action: s.current, expected_cost: ec[s.current], expected_costs: ec, optimal, state: s, lookahead: mode };
}

function hold(state: DecisionState, ec: Record<Action, number>, optimal: Action, mode: Decision["lookahead"]): Decision {
  const s: DecisionState = { ...state, ticks_at_current: state.ticks_at_current + 1, ticks_below: 0, deferred_ticks: (state.deferred_ticks ?? 0) + 1 };
  return { action: s.current, expected_cost: ec[s.current], expected_costs: ec, optimal, state: s, lookahead: mode };
}
