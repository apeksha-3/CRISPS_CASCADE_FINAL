// ml/gate.ts
// The confidence gate: when does the nowcast show a number, and when does it say it cannot?
//
// A probability is only worth showing if it can be trusted. The nowcast shows one only when ALL of these hold:
//   1. the inputs exist           (the traffic model needs the DOT feed; no feed, no traffic forecast)
//   2. the inputs are in range    (every continuous feature lies inside the range seen in training: a model is not asked about
//                                  weather it has never seen)
//   3. there is recent evidence   (at least MIN_TICKS rain ticks, with at least MIN_POSITIVES that really happened, in the last
//                                  RECENT_MONTHS whole months, so the calibration can be checked)
//   4. it has been honest lately  (the expected calibration error over those months is at most ECE_LIMIT: when the model said 70%,
//                                  about that share of the time it really happened, to within 10 percentage points on average)
// Otherwise the dashboard shows "Not enough reliable data to forecast" and no probability.

export const GATE = { recent_months: 3, ece_limit: 0.1, min_ticks: 300, min_positives: 20, bar_scale: 0.15 };
export const GATE_MESSAGE = "Not enough reliable data to forecast";

export interface Recent {
  n: number; // rain ticks with a known outcome in the last RECENT_MONTHS whole months
  positives: number; // how many of them had the event happen
  ece: number | null; // their expected calibration error (null when there are too few to compute it)
}

export type GateReason = "ok" | "missing_input" | "out_of_range" | "too_few_recent" | "calibration";

export interface GateResult {
  show: boolean;
  reason: GateReason;
  detail: string; // one plain sentence for the technical view
}

export interface GateInput {
  recent: Recent | undefined;
  features: Record<string, number>;
  range: Record<string, [number, number]>; // training min and max of each continuous feature
  needsDot: boolean; // the traffic target cannot run without DOT data
}

export function confidenceGate(g: GateInput): GateResult {
  const no = (reason: GateReason, detail: string): GateResult => ({ show: false, reason, detail });
  if (g.needsDot && g.features.dot_ok !== 1) return no("missing_input", "the road-speed feed has no data for the last hour");
  for (const [name, [lo, hi]] of Object.entries(g.range)) {
    const x = g.features[name];
    if (x === undefined || !Number.isFinite(x)) return no("missing_input", `input ${name} is missing`);
    if (x < lo || x > hi) return no("out_of_range", `${name} = ${round(x)} is outside the training range ${round(lo)} to ${round(hi)}`);
  }
  const r = g.recent;
  if (!r || r.ece === null || r.n < GATE.min_ticks || r.positives < GATE.min_positives) return no("too_few_recent", `only ${r?.n ?? 0} recent checks with ${r?.positives ?? 0} real events (need ${GATE.min_ticks} and ${GATE.min_positives})`);
  if (r.ece > GATE.ece_limit) return no("calibration", `over the last ${GATE.recent_months} months its probabilities were off by ${round(100 * r.ece)} points on average (limit ${100 * GATE.ece_limit})`);
  return { show: true, reason: "ok", detail: `calibration error ${round(100 * r.ece)} points over the last ${GATE.recent_months} months (${r.n} checks)` };
}

const round = (x: number) => Math.round(x * 100) / 100;

// The confidence bar: 1 (full) when the calibration error is 0, 0 (empty) at ECE = bar_scale. It comes from calibration quality
// (how honest the probabilities have been), not from Brier or from the size of the probability itself.
export function confidenceBar(ece: number | null | undefined): number {
  if (ece === null || ece === undefined || !Number.isFinite(ece)) return 0;
  return Math.min(1, Math.max(0, 1 - ece / GATE.bar_scale));
}

export const confidenceWord = (bar: number) => (bar >= 0.67 ? "High" : bar >= 0.34 ? "Medium" : "Low");
