// engine/explain.ts
// Plain-language explanations (R7), pipeline step 14. Template sentences only, no LLM.
//
// Each tick says three things:
//   top_evidence     the 3 evidence units with the largest |LLR|, where
//                    LLR = how much more likely the unit is under CASCADE than under
//                    "anything else" (the other 3 hypotheses, weighted by belief):
//                      LLR = row(CASCADE) - ln( sum over h != CASCADE of w(h) * e^row(h) )
//                    w(h) = current P(h) rescaled to sum to 1 over the other three.
//                    Positive = pushes toward cascade, negative = away from it.
//   delta_summary    what moved since last tick, and why (new units, retractions,
//                    forecasts confirmed/missed, sources going dark)
//   forecast_summary the next expected stages, or "no further escalation"

import type { LLRow } from "../config/likelihoods";
import type { ForecastOutcome } from "./forecast";
import {
  type Action,
  type EvidenceContribution,
  type EvidenceUnit,
  type Explanation,
  type ForecastItem,
  HYPOTHESES,
  type Hypothesis,
  type ProbabilityVector,
  type Seconds,
} from "./types";

export const SHORT: Record<Hypothesis, string> = {
  NOISE: "noise",
  SENSOR_FAILURE: "sensor_failure",
  ISOLATED_INCIDENT: "isolated",
  CASCADING_CRISIS: "cascade",
};

// Bayes factor of CASCADE against the belief-weighted rest, in nats.
export function cascadeLLR(row: LLRow, belief: ProbabilityVector): number {
  const others = HYPOTHESES.filter((h) => h !== "CASCADING_CRISIS");
  const total = others.reduce((s, h) => s + belief[h], 0) || 1;
  const mix = others.reduce((s, h) => s + (belief[h] / total) * Math.exp(row[h]), 0);
  return row.CASCADING_CRISIS - Math.log(mix);
}

// The hypothesis a row pushes up the most (ties: the first in HYPOTHESES).
export function supports(row: LLRow): Hypothesis {
  return HYPOTHESES.reduce((best, h) => (row[h] > row[best] + 1e-12 ? h : best), HYPOTHESES[0]);
}

// "what" + "when" (skew-adjusted minutes). A weather-discounted unit says so.
export function describeUnit(u: EvidenceUnit): string {
  const a = (u.first_t / 60).toFixed(1);
  const b = (u.last_t / 60).toFixed(1);
  const weather = u.common_cause ? ", shares one weather cause with its zone" : "";
  return `${describeBody(u)}${weather} [min ${a === b ? a : `${a}-${b}`}]`;
}

function describeBody(u: EvidenceUnit): string {
  const k = u.kind;
  switch (u.unit_type) {
    case "single":
      return `${u.strong ? "" : "low-severity "}${k} from ${u.sources[0] ?? "?"} in ${u.zone_id}`;
    case "near_duplicate":
      return u.surge
        ? `${u.n} distinct ${k} reports in ${u.zone_id} (a genuine surge, counted in full)`
        : `${u.n} ${k} reports in ${u.zone_id}, each within 3 min of another (one incident, counted as ${u.weight.toFixed(1)})`;
    case "gateway_correlated":
      return `gateway ${u.gateway_id}: ${u.n} sensors report the identical value ${u.value} (one unit: a lying gateway)`;
    case "narrative":
      return u.corroborated
        ? `${u.n} citizen reports of one story in ${u.zone_id}, backed by a physical sensor`
        : `${u.n} citizen reports of one story in ${u.zone_id}, no sensor agrees (capped at one report)`;
  }
}

export function topContributors(units: EvidenceUnit[], belief: ProbabilityVector, n = 3): EvidenceContribution[] {
  return units
    .filter((u) => u.n > 0)
    .map((u) => ({
      unit_id: u.unit_id,
      description: describeUnit(u),
      kind: u.kind as EvidenceContribution["kind"],
      zone_id: u.zone_id,
      llr: cascadeLLR(u.hypothesis_contributions, belief),
      supports: supports(u.hypothesis_contributions),
    }))
    .filter((c) => Math.abs(c.llr) > 1e-9)
    .sort((a, b) => Math.abs(b.llr) - Math.abs(a.llr) || (a.unit_id < b.unit_id ? -1 : 1))
    .slice(0, n);
}

// One unit whose contribution changed this tick.
export interface UnitChange {
  unit: EvidenceUnit;
  delta: LLRow; // new row - old row
  retracted: string[]; // ids of members retracted this tick
}

export interface ExplainInput {
  now: Seconds;
  prev?: { probabilities: ProbabilityVector; action: Action; dark: number };
  probabilities: ProbabilityVector;
  action: Action;
  alive: EvidenceUnit[]; // units with evidence in the window (rows filled)
  changes: UnitChange[];
  outcomes: ForecastOutcome[];
  gatewaysLost: { gateway_id: string; sensors: number }[];
  dark: number;
  coverage: number;
  forecast: ForecastItem[];
  benign: boolean;
  chainSeen: number; // causal-chain stages seen so far
  lookahead: "none" | "deferred" | "anticipated";
  lookaheadKind?: string;
}

const p2 = (x: number) => x.toFixed(2);
const zonesOf = (us: EvidenceUnit[]) => [...new Set(us.map((u) => u.zone_id))].sort().join(", ");

function tiltBy(p: ProbabilityVector, row: LLRow, sign: number): ProbabilityVector {
  const w = HYPOTHESES.map((h) => p[h] * Math.exp(sign * row[h]));
  const s = w.reduce((a, b) => a + b, 0);
  const out = {} as ProbabilityVector;
  HYPOTHESES.forEach((h, i) => (out[h] = w[i] / s));
  return out;
}

export function deltaSummary(x: ExplainInput): string {
  const parts: string[] = [];

  // retractions first: "Revised: ..."
  for (const c of x.changes.filter((c) => c.retracted.length > 0)) {
    const without = tiltBy(x.probabilities, c.delta, -1); // belief had the retraction not happened
    const h = HYPOTHESES.reduce((b, k) => (Math.abs(x.probabilities[k] - without[k]) > Math.abs(x.probabilities[b] - without[b]) ? k : b));
    const d = x.probabilities[h] - without[h];
    const effect = Math.abs(d) < 0.005 ? "with negligible effect" : `${d < 0 ? "reducing" : "raising"} P(${SHORT[h]}) by ${Math.abs(d).toFixed(2)}`;
    parts.push(`Revised: event ${c.retracted.join(", ")} was retracted, ${effect}.`);
  }
  for (const g of x.gatewaysLost) parts.push(`Gateway ${g.gateway_id} lost: ${g.sensors} sensors now dark, confidence widened.`);
  if (x.prev && x.dark - x.prev.dark >= 3 && x.gatewaysLost.length === 0) {
    parts.push(`${x.dark - x.prev.dark} more sources went dark (coverage ${p2(x.coverage)}), confidence widened.`);
  }

  // the main move
  if (!x.prev) {
    parts.push(`First tick: P(cascade) ${p2(x.probabilities.CASCADING_CRISIS)}, starting from the base rates.`);
  } else {
    const h = HYPOTHESES.reduce((b, k) => (Math.abs(x.probabilities[k] - x.prev!.probabilities[k]) > Math.abs(x.probabilities[b] - x.prev!.probabilities[b]) ? k : b));
    const from = x.prev.probabilities[h];
    const to = x.probabilities[h];
    const grew = x.changes.filter((c) => c.retracted.length === 0 && c.unit.n > 0);
    // the new evidence that pushed in the direction of the move
    const dir = Math.sign(to - from);
    const pushing = grew
      .map((c) => ({ c, push: c.delta[h] - Math.max(...HYPOTHESES.filter((o) => o !== h).map((o) => c.delta[o])) }))
      .filter((z) => z.push * dir > 1e-9)
      .sort((a, b) => Math.abs(b.push) - Math.abs(a.push));
    const reasons: string[] = [];
    const byKind = new Map<string, EvidenceUnit[]>();
    for (const { c } of pushing.slice(0, 4)) byKind.set(describeKind(c.unit), [...(byKind.get(describeKind(c.unit)) ?? []), c.unit]);
    for (const [k, us] of [...byKind].slice(0, 2)) reasons.push(`${k} arrived in ${zonesOf(us)}`);
    for (const o of x.outcomes) {
      reasons.push(o.outcome === "confirmed" ? `the forecast ${o.kind} arrived on schedule` : `the expected ${o.kind} did not show up in its window`);
    }
    if (Math.abs(to - from) >= 0.02) {
      const why = reasons.length ? reasons.join(", and ") : grew.length ? "new evidence arrived" : "no new evidence (drifting back toward the base rates)";
      parts.push(`P(${SHORT[h]}) ${to > from ? "rose" : "fell"} from ${p2(from)} to ${p2(to)} because ${why}.`);
    } else if (grew.length === 0 && x.outcomes.length === 0 && parts.length === 0) {
      parts.push(`No new evidence this tick, holding at ${x.action}.`);
    } else if (parts.length === 0 || grew.length > 0 || x.outcomes.length > 0) {
      const fc = x.outcomes.length ? ` (${reasons.slice(-x.outcomes.length).join(", and ")})` : "";
      parts.push(`Little change: ${grew.length} evidence unit(s) updated${fc}, P(cascade) ${p2(x.probabilities.CASCADING_CRISIS)}.`);
    }
  }

  if (x.prev && x.prev.action !== x.action) parts.push(`Action ${x.prev.action} -> ${x.action}.`);
  if (x.lookahead === "deferred") parts.push(`Upgrade deferred one tick: waiting to see whether ${x.lookaheadKind} arrives is cheaper than acting now.`);
  if (x.lookahead === "anticipated") parts.push(`The forecast expects ${x.lookaheadKind} soon, so this tick counts toward an upgrade.`);
  return parts.join(" ");
}

function describeKind(u: EvidenceUnit): string {
  if (u.unit_type === "gateway_correlated") return `identical readings from gateway ${u.gateway_id}`;
  if (u.unit_type === "narrative") return u.corroborated ? "corroborated citizen reports" : "uncorroborated citizen reports";
  return u.strong ? `${u.kind} anomalies` : `everyday low-severity ${u.kind} blips`;
}

export function forecastSummary(items: ForecastItem[], benign: boolean, now: Seconds, chainSeen = 0): string {
  const when = (f: ForecastItem) => {
    const a = Math.floor((f.window_p10 - now) / 60);
    const b = Math.max(1, Math.ceil((f.window_p90 - now) / 60));
    return a <= 0 ? `within the next ${b} min` : `in ${a}-${b} min`;
  };
  const line = (f: ForecastItem) => `${f.kind}${f.zones.length ? ` (after ${f.zones.join(", ")})` : ""} ${when(f)} (p=${p2(f.probability)})`;
  if (benign) {
    const next = items[0] ? ` Next stage if it were a cascade: ${line(items[0])}.` : "";
    return `Benign explanations dominate: no further escalation expected; activity should fade to background within a few minutes.${next}`;
  }
  if (items.length === 0 && chainSeen > 0) return `${chainSeen} stage(s) of the causal chain seen; every later stage has already shown up or its window has passed, so nothing new to forecast.`;
  if (items.length === 0) return "No causal chain under way: no downstream escalation expected.";
  return `If cascade, expecting ${items.map(line).join("; then ")}.`;
}

export function explain(x: ExplainInput): Explanation {
  return {
    top_evidence: topContributors(x.alive, x.probabilities),
    delta_summary: deltaSummary(x),
    forecast_summary: forecastSummary(x.forecast, x.benign, x.now, x.chainSeen),
  };
}
