// engine/forecast.ts
// Causal-chain forecast (R3), pipeline step 13.
//
// The causal graph (config/causal-graph.ts) says a cascade unrolls in order:
//   rain -> drainage -> traffic -> emergency calls -> hospital -> power/comms
// and each step follows the previous one after a lag (mean, sd).
//
// 1. STAGES SEEN. A stage counts as seen once enough strong, in-chain evidence of
//    its kind arrived (rain is the root; the others must be `chained`, i.e. their
//    predecessor came first). Lying gateways and rumors never count.
// 2. FORECAST. From the LATEST seen stage L (seen at time tL), each later stage K is
//    expected at  tL + (sum of the lag means from L to K),  with
//    sd = sqrt(sum of lag variances + detection noise). Window [p10, p90] = mean -/+ 1.28 sd.
//    probability = P(cascade) x (product of pass-through chances from L to K):
//    not every cascade reaches every stage, and benign days reach none.
//    The next 3 stages whose window has not passed are the forecast.
// 3. CHECK LAST TICK'S FORECAST (this is how forecasting improves lead time):
//    confirmed  the predicted stage showed up inside its window -> CASCADE gets a
//               bonus (+0.3 log-likelihood). The chain is unrolling on schedule,
//               which is what a cascade does and what noise does not.
//    missed     the window (plus detection slack) passed with no sign of the stage.
//               Under a cascade that happens with chance 1 - pass_through, under
//               benign stories it is expected, so CASCADE gets
//               ln(1 - pass_through x coverage x miss_strength) (negative).
//               Scaled by coverage: if sensors are dark, missing is not evidence (R5).
// 4. LOOKAHEAD INPUT for engine/decide.ts: the chance the next stage arrives in the
//    next tick, and what the belief would look like if it does / does not.

import { CAUSAL_EDGES, CAUSAL_ORDER } from "../config/causal-graph";
import { FORECAST_KNOBS } from "../config/knobs";
import { type LikelihoodTables, type LLRow, TUNED_TABLES } from "../config/likelihoods";
import { normalizeLog, zeroRow } from "./filter";
import { type EventKind, type EvidenceUnit, type ForecastItem, HYPOTHESES, type ProbabilityVector, type Seconds } from "./types";

export interface StageSeen {
  kind: EventKind;
  t: Seconds; // earliest adjusted time of its in-chain evidence
  zones: string[];
}

// One expected stage, with what the checker needs (not all of it is shown).
export interface ForecastLine extends ForecastItem {
  mean: Seconds;
  sd: Seconds;
  pass: number; // pass-through from the latest seen stage to this one
}

export interface ForecastOutcome {
  kind: EventKind;
  outcome: "confirmed" | "missed";
  ll: LLRow; // what it added to the filter
}

export interface ForecastState {
  seen: Partial<Record<EventKind, StageSeen>>;
  resolved: Partial<Record<EventKind, "confirmed" | "missed" | "off_window">>;
  lines: ForecastLine[]; // ALL downstream stages forecast at the end of the last tick
  last_chain_at: Seconds; // last tick with in-chain evidence
}

export const initialForecastState = (): ForecastState => ({ seen: {}, resolved: {}, lines: [], last_chain_at: -Infinity });

const ROOT = CAUSAL_ORDER[0];
const edgeInto = (k: EventKind) => CAUSAL_EDGES.find((e) => e.to === k)!;

// Does this unit count as evidence that stage `kind` of the chain is happening?
export function isChainEvidence(u: EvidenceUnit): boolean {
  if (!CAUSAL_ORDER.includes(u.kind) || u.n === 0 || !u.strong) return false;
  if (u.unit_type === "gateway_correlated" || u.unit_type === "narrative") return false;
  return u.kind === ROOT || u.chained;
}

// Step 1. Returns the kinds seen for the first time this tick.
export function updateStages(state: ForecastState, units: EvidenceUnit[], now: Seconds, k = FORECAST_KNOBS): EventKind[] {
  const chain = units.filter(isChainEvidence);
  if (chain.length > 0) state.last_chain_at = now;
  else if (now - state.last_chain_at > k.reset_after_quiet_s) Object.assign(state, initialForecastState()); // the chain went cold: start over
  const fresh: EventKind[] = [];
  for (const kind of CAUSAL_ORDER) {
    const us = chain.filter((u) => u.kind === kind);
    const zones = [...new Set(us.map((u) => u.zone_id))].sort();
    const s = state.seen[kind];
    if (s) {
      s.zones = [...new Set([...s.zones, ...zones])].sort();
      continue;
    }
    if (us.reduce((w, u) => w + u.weight, 0) < k.stage_min_weight) continue;
    state.seen[kind] = { kind, t: Math.min(...us.map((u) => u.first_t)), zones };
    fresh.push(kind);
  }
  return fresh;
}

// Step 3. Compare last tick's forecast with what happened.
export function checkForecasts(state: ForecastState, freshKinds: EventKind[], now: Seconds, coverage: number, k = FORECAST_KNOBS): ForecastOutcome[] {
  const out: ForecastOutcome[] = [];
  for (const line of state.lines) {
    if (state.resolved[line.kind]) continue;
    const seen = state.seen[line.kind];
    if (seen && freshKinds.includes(line.kind)) {
      const inWindow = seen.t >= line.window_p10 && seen.t <= line.window_p90 + k.detection_slack_s;
      state.resolved[line.kind] = inWindow ? "confirmed" : "off_window";
      if (inWindow) out.push({ kind: line.kind, outcome: "confirmed", ll: { ...zeroRow(), CASCADING_CRISIS: confirmBonus(line.kind, k) } });
    } else if (!seen && now > line.window_p90 + k.detection_slack_s) {
      state.resolved[line.kind] = "missed";
      out.push({ kind: line.kind, outcome: "missed", ll: missRow(line.pass, coverage, k) });
    }
  }
  return out;
}

// Downstream stages (hospital, power) confirmed on schedule are worth more: wet
// weather alone never produces them, so they separate cascades from rain days.
export function confirmBonus(kind: EventKind, k = FORECAST_KNOBS): number {
  return DOWNSTREAM.has(kind) ? k.confirm_bonus_downstream_ll : k.confirm_bonus_ll;
}
const DOWNSTREAM = new Set<EventKind>(["hospital_arrivals_unusual", "power_comms_load"]);

export function missRow(pass: number, coverage: number, k = FORECAST_KNOBS): LLRow {
  return { ...zeroRow(), CASCADING_CRISIS: Math.log(Math.max(1e-3, 1 - pass * coverage * k.miss_strength)) };
}

// Step 2. Every stage after the latest seen one, in causal order.
export function forecastLines(state: ForecastState, posterior: ProbabilityVector, k = FORECAST_KNOBS): ForecastLine[] {
  let latest = -1;
  CAUSAL_ORDER.forEach((kind, i) => {
    if (state.seen[kind]) latest = i;
  });
  if (latest < 0) return [];
  const from = state.seen[CAUSAL_ORDER[latest]]!;
  const lines: ForecastLine[] = [];
  let mean = from.t;
  let variance = 2 * k.detection_sd_s ** 2; // both detections are late by a random amount
  let pass = 1;
  for (let i = latest + 1; i < CAUSAL_ORDER.length; i++) {
    const kind = CAUSAL_ORDER[i];
    const edge = edgeInto(kind);
    mean += edge.lag.mean;
    variance += edge.lag.sd ** 2;
    pass *= edge.pass_through;
    const sd = Math.sqrt(variance);
    lines.push({
      kind,
      probability: posterior.CASCADING_CRISIS * pass,
      window_p10: Math.round(mean - k.window_z * sd),
      window_p90: Math.round(mean + k.window_z * sd),
      expected_at: Math.round(mean),
      zones: from.zones,
      mean,
      sd,
      pass,
    });
  }
  return lines;
}

// What the TickRecord shows: the next 3 stages that are not overdue yet.
export function visibleForecast(lines: ForecastLine[], state: ForecastState, now: Seconds): ForecastItem[] {
  return lines
    .filter((l) => !state.resolved[l.kind] && l.window_p90 >= now)
    .slice(0, 3)
    .map(({ kind, probability, window_p10, window_p90, expected_at, zones }) => ({ kind, probability, window_p10, window_p90, expected_at, zones }));
}

export const isBenign = (p: ProbabilityVector, k = FORECAST_KNOBS) => p.NOISE + p.SENSOR_FAILURE > k.benign_threshold;

// ---- Step 4: one-step lookahead input ----

// Standard normal CDF via the Abramowitz-Stegun erf approximation (error < 1.5e-7).
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

export interface Lookahead {
  kind: EventKind;
  q: number; // chance the stage shows up during the next tick
  ifArrives: ProbabilityVector;
  ifNot: ProbabilityVector;
}

function tilt(p: ProbabilityVector, row: LLRow): ProbabilityVector {
  const logp = zeroRow();
  for (const h of HYPOTHESES) logp[h] = Math.log(Math.max(1e-300, p[h])) + row[h];
  return normalizeLog(logp);
}

// Point estimate (no Monte Carlo): the first pending stage whose window is open or
// about to close. "Arrives" = one chained event of that kind + the confirmation bonus.
// "Not" = nothing changes, or the miss penalty if its window closes next tick.
export function lookahead(
  lines: ForecastLine[],
  state: ForecastState,
  posterior: ProbabilityVector,
  now: Seconds,
  coverage: number,
  step = 60,
  k = FORECAST_KNOBS,
  tables: LikelihoodTables = TUNED_TABLES,
): Lookahead | undefined {
  const line = lines.find((l) => !state.resolved[l.kind] && l.window_p10 <= now + step && now <= l.window_p90 + k.detection_slack_s);
  if (!line) return undefined;
  const table = tables.kinds[line.kind];
  const arriveRow = zeroRow();
  if (table) for (const h of HYPOTHESES) arriveRow[h] = (table.chained ?? table.alone)[h];
  arriveRow.CASCADING_CRISIS += confirmBonus(line.kind, k);
  // hazard: P(arrives in (now, now+step] | not arrived by now), under a cascade
  const sd = Math.max(1, line.sd);
  const before = normalCdf((now - line.mean) / sd);
  const by = normalCdf((now + step - line.mean) / sd);
  const hazard = before < 1 - 1e-9 ? (by - before) / (1 - before) : 1;
  const q = Math.min(1, posterior.CASCADING_CRISIS * line.pass * hazard);
  const closes = now + step > line.window_p90 + k.detection_slack_s;
  return {
    kind: line.kind,
    q,
    ifArrives: tilt(posterior, arriveRow),
    ifNot: closes ? tilt(posterior, missRow(line.pass, coverage, k)) : posterior,
  };
}
