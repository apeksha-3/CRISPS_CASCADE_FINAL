// engine/trust.ts
// Per-source trust as a Beta(alpha, beta) distribution (R4).
//
// Think of alpha as "times this source was right" and beta as "times it was wrong",
// plus a starting guess per source type (config/trust-priors.ts).
//   trust = mean of the Beta = alpha / (alpha + beta)
// Beta(5, 1) = 0.83 (we expect it to be right), Beta(1, 2) = 0.33 (skeptical).
//
// Two kinds of update:
//   WITHIN an episode (no ground truth): an event that agrees with the hypothesis
//     the engine currently believes most adds a small step (0.1) to alpha.
//   BETWEEN episodes (truth revealed, engine/learn.ts): first everything is
//     multiplied by the forgetting factor 0.98 (old history fades), then each event
//     that supported the truth adds 1 to alpha, each misleading event 1 to beta.
//     Which events "supported the truth"? Two ways, depending on what is revealed:
//       event labels  (the eval, and a control room's after-action review): an event
//                     is right if it reported something that really happened, wrong if
//                     it was a false alarm, a lie, or part of a rumor. This is what
//                     "crying wolf" means, so it is what we use whenever labels exist.
//       outcome only  (fallback): right if the true hypothesis is at the top of the
//                     event's likelihood row (judgeEvent below).
//
// Trust is used for TEMPERING in the filter: a unit's log-likelihood row is
// multiplied by its sources' trust, so a 0.3-trust source moves the belief only
// 30% as far (in log space) as a fully trusted one. A unit with several sources
// uses their GEOMETRIC mean: (t1 x t2 x ... x tn)^(1/n). One bad source drags it
// down more than an arithmetic mean would.

import type { LLRow } from "../config/likelihoods";
import { type BetaParams, TRUST_KNOBS, TRUST_PRIORS } from "../config/trust-priors";
import { HYPOTHESES, type Hypothesis, type PublicRegistry, type SourceType, type TrustSnapshot } from "./types";

// Trust of every source we have ever heard of, by source id.
export type TrustState = Record<string, TrustSnapshot>;

export const betaMean = (b: BetaParams) => (b.alpha + b.beta > 0 ? b.alpha / (b.alpha + b.beta) : 0.5);

export function snapshot(source_id: string, source_type: SourceType, b: BetaParams): TrustSnapshot {
  return { source_id, source_type, alpha: b.alpha, beta: b.beta, mean: betaMean(b) };
}

// A source's trust: learned if we know it, else the starting guess for its type.
export function trustOf(state: TrustState, source_id: string, source_type: SourceType): TrustSnapshot {
  return state[source_id] ?? snapshot(source_id, source_type, TRUST_PRIORS[source_type]);
}

// Make sure every source of this city has an entry (unknown ones start at their type prior).
export function withRegistry(state: TrustState, registry: PublicRegistry): TrustState {
  const out: TrustState = { ...state };
  for (const s of registry.sources) out[s.source_id] = trustOf(state, s.source_id, s.source_type);
  return out;
}

export function geometricMean(xs: number[]): number {
  if (xs.length === 0) return 0;
  // exp(mean of logs) = the n-th root of the product, without underflow
  return Math.exp(xs.reduce((s, x) => s + Math.log(Math.max(1e-9, x)), 0) / xs.length);
}

// Within an episode: this source's event agreed with the leading hypothesis.
export function bump(t: TrustSnapshot, step = TRUST_KNOBS.in_episode_step): TrustSnapshot {
  return snapshot(t.source_id, t.source_type, { alpha: t.alpha + step, beta: t.beta });
}

// The hypothesis an event's row pushes toward, or undefined if the row barely
// prefers anything (top less than `tol` above the runner-up).
export function claimOf(row: LLRow, tol = TRUST_KNOBS.judge_tolerance): Hypothesis | undefined {
  const sorted = HYPOTHESES.slice().sort((a, b) => row[b] - row[a]);
  return row[sorted[0]] - row[sorted[1]] >= tol ? sorted[0] : undefined;
}

// After the episode: did this event support the true hypothesis?
// "Support" = the truth is at (or within `tol` of) the top of the event's row:
// the event made the truth look at least as likely as anything else.
export function judgeEvent(row: LLRow, truth: Hypothesis, tol = TRUST_KNOBS.judge_tolerance): "support" | "mislead" {
  const best = Math.max(...HYPOTHESES.filter((h) => h !== truth).map((h) => row[h]));
  return row[truth] >= best - tol ? "support" : "mislead";
}

// One scored event, remembered for the end-of-episode trust update.
export interface SourceEvidence {
  event_id: string;
  source_id: string;
  source_type: SourceType;
  row: LLRow; // the likelihood row of what the event claimed (its kind, alone or chained)
}

// Revealed after the episode: was this event real? (true / false, undefined = not labelled)
export type EventLabels = (event_id: string) => boolean | undefined;

// Between episodes: forget a little, then count supporting / misleading events.
export function updateTrust(state: TrustState, evidence: SourceEvidence[], truth: Hypothesis, labels?: EventLabels, forgetting = TRUST_KNOBS.forgetting): TrustState {
  const out: TrustState = {};
  for (const [id, t] of Object.entries(state)) out[id] = snapshot(id, t.source_type, { alpha: t.alpha * forgetting, beta: t.beta * forgetting });
  for (const e of evidence) {
    const t = out[e.source_id] ?? trustOf({}, e.source_id, e.source_type);
    const right = labels?.(e.event_id) ?? judgeEvent(e.row, truth) === "support";
    out[e.source_id] = snapshot(e.source_id, e.source_type, { alpha: t.alpha + (right ? 1 : 0), beta: t.beta + (right ? 0 : 1) });
  }
  return out;
}

// Top / bottom sources by trust (ties by id, so the list is deterministic).
export function rankTrust(state: TrustState): TrustSnapshot[] {
  return Object.values(state).sort((a, b) => b.mean - a.mean || (a.source_id < b.source_id ? -1 : 1));
}
