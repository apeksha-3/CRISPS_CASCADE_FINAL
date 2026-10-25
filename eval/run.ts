// eval/run.ts
// Run one policy over one episode, tick by tick, and score it.
// At tick t the policy sees ONLY events with arrived_at <= t (R8).

import { BASE_RATES } from "../config/transitions";
import { ACTIONS, HYPOTHESES, type ProbabilityVector, type TickRecord } from "../engine/types";
import { groupOf, type Split } from "../sim/dataset";
import { rngFor } from "../sim/rng";
import { SEEDS } from "../sim/params";
import type { Episode } from "../sim/truth";
import type { Policy, PolicyOutput } from "./baselines";
import { brierScore, flipFlops, level, logLoss, mean, sqDistance, tickCost } from "./metrics";

export const COMMIT_P = 0.6; // "committed" = top hypothesis is the truth with p >= 0.6

export interface EpisodeResult {
  episode_id: string;
  group: string;
  hypothesis: string;
  ticks: number;
  brier: number; // mean over ticks
  log_loss: number; // mean over ticks
  cost_total: number;
  cost_per_tick: number; // cost_total / ticks: long and short episodes count equally
  max_action: string;
  any_alert: boolean; // some tick at ALERT or above
  lead_min?: number; // critical_time - first ALERT tick, minutes (cascades only)
  flips: number;
  fallback_ticks: number;
  degraded_ticks: number;
  prior: ProbabilityVector; // the base rates this episode started from (learned since Phase 4)
  twin_role?: string;
  pre_split_overconf?: number; // mean squared distance from the base rates before the split
  commit_min?: number | null; // minutes after the split until committed to the truth (null = never)
  forecast_items: number; // distinct forecast lines issued whose window closed before the episode ended
  forecast_hits: number; // of those: a real event of that kind truly happened inside [p10, p90]
  forecast_start_hits: number; // stricter: the true START of that stage (first zone) lies inside [p10, p90]
}

// Forecast accuracy (Phase 3). Every distinct (kind, p10, p90) the policy forecast
// counts once. It is a hit if a REAL event of that kind (not background noise, not
// a lie, not a rumor) truly occurred inside the window. Uses ground truth, so it
// lives here in eval, never in the engine.
// The stricter score asks whether the stage truly STARTED inside the window.
export function forecastHits(records: TickRecord[], ep: Episode): { items: number; hits: number; startHits: number } {
  const seen = new Set<string>();
  let items = 0;
  let hits = 0;
  let startHits = 0;
  for (const r of records) {
    for (const f of r.forecast) {
      const key = `${f.kind}|${f.window_p10}|${f.window_p90}`;
      if (seen.has(key) || f.window_p90 > ep.duration) continue;
      seen.add(key);
      items++;
      const hit = ep.events.some((e) => {
        const t = ep.truth.event_truths[e.id];
        return e.kind === f.kind && t && !t.is_background && !t.is_lie && !t.is_mimic && t.true_occurred_at >= f.window_p10 && t.true_occurred_at <= f.window_p90;
      });
      if (hit) hits++;
      const start = ep.truth.stage_times[f.kind];
      if (start !== undefined && start >= f.window_p10 && start <= f.window_p90) startHits++;
    }
  }
  return { items, hits, startHits };
}

function makeRecord(t: number, out: PolicyOutput): TickRecord {
  return {
    tick_time: t,
    probabilities: out.probabilities,
    action: out.action,
    expected_cost: NaN,
    expected_costs: { WATCH: NaN, PREPARE: NaN, ALERT: NaN, ESCALATE: NaN }, // baselines do not compute these
    forecast: [],
    explanation: { top_evidence: [], delta_summary: "", forecast_summary: "" },
    evidence_units: 0,
    clusters: 0,
    degraded: false,
    fallback: false,
    source_statuses: {},
    source_summary: { live: 0, stale: 0, dark: 0, total: 0, coverage: 1 },
    trust: [],
    retroactive_revisions: [],
    quarantined: [],
    unparsed: 0,
  };
}

export function runEpisode(policy: Policy, ep: Episode): { records: TickRecord[]; result: EpisodeResult } {
  const truth = ep.truth;
  const byArrival = ep.events.slice().sort((a, b) => a.arrived_at - b.arrived_at);
  const records: TickRecord[] = [];
  const step = policy.start?.(ep.registry); // stateful policies (the engine) get only new arrivals
  let cut = 0;
  for (let t = 60; t <= ep.duration; t += 60) {
    const prev = cut;
    while (cut < byArrival.length && byArrival[cut].arrived_at <= t) cut++;
    if (step) records.push(step(byArrival.slice(prev, cut), t));
    else records.push(makeRecord(t, policy.decide!(byArrival.slice(0, cut), t, ep.registry))); // future events are never passed in
  }

  const h = truth.hypothesis;
  const costs = records.map((r) => tickCost(r.action, h, truth.onset === undefined ? 0 : (r.tick_time - truth.onset) / 60));
  const costTotal = costs.reduce((s, c) => s + c, 0);
  const firstAlert = records.find((r) => level(r.action) >= level("ALERT"));
  const result: EpisodeResult = {
    episode_id: ep.episode_id,
    group: groupOf(ep),
    hypothesis: h,
    ticks: records.length,
    brier: mean(records.map((r) => brierScore(r.probabilities, h))),
    log_loss: mean(records.map((r) => logLoss(r.probabilities, h))),
    cost_total: costTotal,
    cost_per_tick: costTotal / records.length,
    max_action: ACTIONS[Math.max(...records.map((r) => level(r.action)))],
    any_alert: firstAlert !== undefined,
    flips: flipFlops(records.map((r) => r.action)),
    fallback_ticks: records.filter((r) => r.fallback).length,
    degraded_ticks: records.filter((r) => r.degraded).length,
    prior: policy.basePrior?.() ?? { ...BASE_RATES },
    forecast_items: 0,
    forecast_hits: 0,
    forecast_start_hits: 0,
  };
  if (h === "CASCADING_CRISIS") {
    const fh = forecastHits(records, ep);
    result.forecast_items = fh.items;
    result.forecast_hits = fh.hits;
    result.forecast_start_hits = fh.startHits;
  }
  if (h === "CASCADING_CRISIS" && truth.critical_time !== undefined && firstAlert) {
    result.lead_min = (truth.critical_time - firstAlert.tick_time) / 60;
  }
  if (truth.split_time !== undefined) {
    const split = truth.split_time;
    result.twin_role = truth.twin_role;
    // before the split the ideal belief is the base-rate mixture: the prior THIS episode started from
    result.pre_split_overconf = mean(records.filter((r) => r.tick_time <= split).map((r) => sqDistance(r.probabilities, result.prior)));
    const committed = records.find((r) => {
      if (r.tick_time <= split) return false;
      const top = HYPOTHESES.reduce((a, b) => (r.probabilities[b] > r.probabilities[a] ? b : a));
      return top === h && r.probabilities[h] >= COMMIT_P;
    });
    result.commit_min = committed ? (committed.tick_time - split) / 60 : null;
  }
  return { records, result };
}

// The order episodes are played in. The prior-shift sequence must stay in its
// order (the regime change happens at episode 51). Dev and test files are sorted
// by type, which would hand a learning policy 40 cascades in a row, so they are
// played in one fixed shuffled order (seeded: every run sees the same order).
export function evalOrder<T extends { episode_id: string }>(split: Split, episodes: T[]): T[] {
  const sorted = episodes.slice().sort((a, b) => (a.episode_id < b.episode_id ? -1 : 1));
  if (split === "prior-shift") return sorted;
  return rngFor(split === "dev" ? SEEDS.dev : SEEDS.test, "eval-order").shuffle(sorted);
}

// Revealed after the episode: was each event REAL (part of something that truly
// happened), or a false alarm (background blip), a lie (lying gateway) or a rumor?
export function eventLabels(ep: Episode): (id: string) => boolean | undefined {
  return (id) => {
    const t = ep.truth.event_truths[id];
    return t ? !t.is_background && !t.is_lie && !t.is_mimic : undefined;
  };
}

// Play a whole sequence. After each episode a learning policy is told the truth.
export function runSequence(policy: Policy, episodes: Episode[]): EpisodeResult[] {
  return episodes.map((ep) => {
    const { result } = runEpisode(policy, ep);
    policy.afterEpisode?.(ep.truth.hypothesis, eventLabels(ep));
    return result;
  });
}
