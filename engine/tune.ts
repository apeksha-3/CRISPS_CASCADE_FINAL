// engine/tune.ts
// Dev-set calibration helpers (pure math, no data loading). The CLI that loads
// the dev episodes and writes the config files is eval/tune.ts
// (`npm run tune -- --split dev`); it never runs on test.
//
// A. LIKELIHOOD TUNING: coordinate search (a grid search, one number at a time).
//    For every tunable cell of every likelihood row (e.g. drainage_anomaly.chained
//    under CASCADE), try adding -0.2, -0.1, +0.1, +0.2 nats. Keep the best change if
//    it lowers the dev Brier score. One sweep over all cells = one pass.
//    "Dev Brier" here = the Brier score per episode TYPE (cascade, rain_only, noise...),
//    averaged over the types, so the 40-episode buckets do not outvote the 12 rain-only days.
//    DO-NO-HARM RULES: a change is kept only if
//      (1) no episode type ends up more than 0.01 Brier worse than with the hand-set tables, and
//      (2) no MORE benign dev episodes (truth NOISE / SENSOR_FAILURE) "would alert" than with
//          the hand-set tables: the cost-optimal action is ALERT or higher for 2 ticks in a
//          row (what hysteresis needs), or P(cascade) > 0.9 (fast commit).
//    Without them the tuner happily traded false alarms for earlier cascade calls (dev
//    rain-only alerts 17% -> 58%): dev is 28% cascades while the prior says 10%, and the
//    cheapest way to fix that mismatch is to make every rainy sign look more like a cascade.
//    Brier alone cannot see a false alarm; rule (2) is the false-alarm guard.
//    The NOISE column is never touched: only DIFFERENCES within a row matter, so
//    NOISE is the fixed reference and the other 3 columns move relative to it.
//
//    Speed trick (REPLAY). A full engine run over dev takes ~10 s, and a pass tries
//    ~180 changes. But the belief at each tick is
//        log score(H) = log(predict(last belief))(H) + sum over table rows r of coef(r) x row_r(H) + fixed(H)
//    where coef(r) = how much of row r was added this tick (weight x trust, new
//    minus withdrawn) and fixed = silence + forecast bonuses (no table in them).
//    eval/tune.ts records coef / fixed / coverage for every tick once, and replay()
//    recomputes the beliefs for ANY tables in milliseconds. Things that depend on the
//    belief itself (in-episode trust bumps, the trust learned between episodes) are
//    held at their recorded values, so replay is an approximation; that is why each
//    pass starts from a fresh full run, and the result is checked with a full run.
//
// B. LAG TUNING: the mean and sd of the measured stage-to-stage lags.

import type { LikelihoodTables, LLRow } from "../config/likelihoods";
import { transitionsFor } from "../config/transitions";
import { expectedCosts, optimalAction } from "./decide";
import { normalizeLog, predict, zeroRow } from "./filter";
import { type EventKind, HYPOTHESES, type Hypothesis, type ProbabilityVector } from "./types";

export interface TickTrace {
  coef: Record<string, number>; // row key -> amount added this tick (can be negative)
  fixed: LLRow; // silence + forecast confirmed / missed
  coverage: number;
}

export interface EpisodeTrace {
  episode_id: string;
  group: string;
  truth: Hypothesis; // the label, for scoring only
  prior: ProbabilityVector; // the base rates the episode started from
  ticks: TickTrace[];
}

// ---- table cells ----

// Every row of a table set, by key ("rain_heavy.alone", "low", ...).
export function tableRows(t: LikelihoodTables): Record<string, LLRow> {
  const out: Record<string, LLRow> = { low: t.low, gateway: t.gateway, rumor: t.rumor };
  for (const [kind, k] of Object.entries(t.kinds)) {
    if (!k) continue;
    out[`${kind}.alone`] = k.alone;
    if (k.chained) out[`${kind}.chained`] = k.chained;
  }
  return out;
}

export interface Cell {
  key: string; // row key
  h: Hypothesis;
}

export const TUNED_COLUMNS: Hypothesis[] = ["SENSOR_FAILURE", "ISOLATED_INCIDENT", "CASCADING_CRISIS"];

export function tunableCells(t: LikelihoodTables): Cell[] {
  return Object.keys(tableRows(t)).flatMap((key) => TUNED_COLUMNS.map((h) => ({ key, h })));
}

export function getCell(t: LikelihoodTables, c: Cell): number {
  return tableRows(t)[c.key][c.h];
}

// A deep copy of the tables with one cell changed (rounded to 0.01 nats).
export function withCell(t: LikelihoodTables, c: Cell, value: number): LikelihoodTables {
  const out = structuredClone(t);
  tableRows(out)[c.key][c.h] = Math.round(value * 100) / 100;
  return out;
}

// ---- replay ----

const brier = (p: ProbabilityVector, truth: Hypothesis) => HYPOTHESES.reduce((s, h) => s + (p[h] - (h === truth ? 1 : 0)) ** 2, 0);

const isBenign = (h: Hypothesis) => h === "NOISE" || h === "SENSOR_FAILURE";

// Mean Brier of one episode under these tables (same math as engine/filter.ts),
// and whether the decision layer would (roughly) have gone to ALERT.
export function replayEpisodeFull(ep: EpisodeTrace, rows: Record<string, LLRow>): { brier: number; wouldAlert: boolean } {
  const T = transitionsFor(ep.prior);
  let raw = { ...ep.prior };
  let total = 0;
  let run = 0; // consecutive ticks whose cost-optimal action is ALERT or higher
  let wouldAlert = false;
  for (const t of ep.ticks) {
    const predicted = predict(raw, T);
    const logp = zeroRow();
    for (const h of HYPOTHESES) logp[h] = Math.log(Math.max(1e-300, predicted[h])) + t.fixed[h];
    for (const [key, c] of Object.entries(t.coef)) {
      const r = rows[key];
      for (const h of HYPOTHESES) logp[h] += c * r[h];
    }
    raw = normalizeLog(logp);
    const post = zeroRow();
    for (const h of HYPOTHESES) post[h] = t.coverage * raw[h] + (1 - t.coverage) * ep.prior[h];
    total += brier(post, ep.truth);
    const opt = optimalAction(expectedCosts(post));
    run = opt === "ALERT" || opt === "ESCALATE" ? run + 1 : 0;
    if (run >= 2 || post.CASCADING_CRISIS > 0.9) wouldAlert = true;
  }
  return { brier: ep.ticks.length ? total / ep.ticks.length : 0, wouldAlert };
}

export const replayEpisode = (ep: EpisodeTrace, rows: Record<string, LLRow>): number => replayEpisodeFull(ep, rows).brier;

// Per-type Brier plus how many benign episodes would alert.
export function replayStats(eps: EpisodeTrace[], tables: LikelihoodTables): { types: Map<string, number>; objective: number; benignAlerts: number } {
  const rows = tableRows(tables);
  const per = eps.map((ep) => ({ ep, r: replayEpisodeFull(ep, rows) }));
  const types = perType(per.map(({ ep, r }) => ({ group: ep.group, brier: r.brier })));
  const objective = [...types.values()].reduce((a, b) => a + b, 0) / types.size;
  return { types, objective, benignAlerts: per.filter(({ ep, r }) => isBenign(ep.truth) && r.wouldAlert).length };
}

// Mean over episodes of the per-episode mean Brier (the eval's headline number).
export function replayBrier(eps: EpisodeTrace[], tables: LikelihoodTables): number {
  const rows = tableRows(tables);
  return eps.reduce((s, ep) => s + replayEpisode(ep, rows), 0) / eps.length;
}

// Mean over episode TYPES of each type's mean Brier: what the search minimizes.
export function typeBalanced(perEpisode: { group: string; brier: number }[]): number {
  const by = new Map<string, number[]>();
  for (const e of perEpisode) by.set(e.group, [...(by.get(e.group) ?? []), e.brier]);
  const means = [...by.values()].map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
  return means.reduce((a, b) => a + b, 0) / means.length;
}

// Mean Brier per episode type.
export function perType(perEpisode: { group: string; brier: number }[]): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const e of perEpisode) by.set(e.group, [...(by.get(e.group) ?? []), e.brier]);
  return new Map([...by.entries()].map(([g, xs]) => [g, xs.reduce((a, b) => a + b, 0) / xs.length]));
}

export const replayObjective = (eps: EpisodeTrace[], tables: LikelihoodTables): number => replayStats(eps, tables).objective;

// Do-no-harm: every type's Brier must stay at or below its limit.
export const NO_HARM_TOLERANCE = 0.01;
const feasible = (types: Map<string, number>, limits?: Map<string, number>) => !limits || [...types].every(([g, b]) => b <= (limits.get(g) ?? Infinity));

export interface SearchStep {
  cell: Cell;
  from: number;
  to: number;
  objective: number; // replay type-balanced Brier after the change
}

// One pass of coordinate search. Changes are applied as they are found
// (later cells are tried on top of earlier improvements).
// limits: the most Brier each type may have (hand-set Brier + NO_HARM_TOLERANCE);
// maxBenignAlerts: the most benign episodes that may "would alert" (hand-set's count).
export function searchPass(
  eps: EpisodeTrace[],
  start: LikelihoodTables,
  limits?: Map<string, number>,
  maxBenignAlerts = Infinity,
  steps = [-0.2, -0.1, 0.1, 0.2],
): { tables: LikelihoodTables; objective: number; changes: SearchStep[] } {
  let tables = start;
  let best = replayObjective(eps, tables);
  const changes: SearchStep[] = [];
  for (const cell of tunableCells(start)) {
    const from = getCell(tables, cell);
    let pick: { tables: LikelihoodTables; objective: number; to: number } | undefined;
    for (const d of steps) {
      const candidate = withCell(tables, cell, from + d);
      const st = replayStats(eps, candidate);
      if (!feasible(st.types, limits) || st.benignAlerts > maxBenignAlerts) continue;
      const b = st.objective;
      if (b < (pick?.objective ?? best) - 1e-6) pick = { tables: candidate, objective: b, to: getCell(candidate, cell) };
    }
    if (pick) {
      tables = pick.tables;
      best = pick.objective;
      changes.push({ cell, from, to: pick.to, objective: pick.objective });
    }
  }
  return { tables, objective: best, changes };
}

// ---- lags ----

export interface LagStat {
  mean: number;
  sd: number;
  n: number;
}

// Mean and sample sd of each edge's measured lags (seconds), rounded to whole seconds.
// Edges with fewer than `minN` measurements are left out (the hand-set lag is kept).
export function lagStats(samples: { to: EventKind; lag: number }[], minN = 5): Partial<Record<EventKind, LagStat>> {
  const by = new Map<EventKind, number[]>();
  for (const s of samples) by.set(s.to, [...(by.get(s.to) ?? []), s.lag]);
  const out: Partial<Record<EventKind, LagStat>> = {};
  for (const [to, xs] of by) {
    if (xs.length < minN) continue;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
    out[to] = { mean: Math.round(mean), sd: Math.round(sd), n: xs.length };
  }
  return out;
}
