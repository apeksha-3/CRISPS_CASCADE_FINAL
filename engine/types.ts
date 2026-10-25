// engine/types.ts
// Shared types the ENGINE is allowed to see. Everything here is "observable":
// it could come from a real city feed.
// Hidden simulator facts (true hypothesis, true reliability, clock offsets...)
// live in sim/truth.ts. The engine must never import that file.

// The 4 explanations the engine weighs against each other.
export const HYPOTHESES = [
  "NOISE",
  "SENSOR_FAILURE",
  "ISOLATED_INCIDENT",
  "CASCADING_CRISIS",
] as const;
export type Hypothesis = (typeof HYPOTHESES)[number];

// A probability for each hypothesis. Always sums to 1.
export type ProbabilityVector = Record<Hypothesis, number>;

// The 4 buttons the duty officer can press, cheapest/least disruptive first.
// The order matters: hysteresis (R6) moves one level at a time along this list.
export const ACTIONS = ["WATCH", "PREPARE", "ALERT", "ESCALATE"] as const;
export type Action = (typeof ACTIONS)[number];
export type ActionLevel = Action; // same thing; the name used in the Phase 2 brief

// Where an event came from.
export type SourceType =
  | "rain_gauge"
  | "drainage_sensor"
  | "traffic_sensor"
  | "camera"
  | "dispatch" // emergency call / dispatch log
  | "hospital"
  | "utility" // power / comms load
  | "citizen_report"
  | "gateway"; // the box that relays many sensors (can fail as one unit)

// What the event says happened.
export type EventKind =
  | "rain_heavy"
  | "drainage_anomaly"
  | "traffic_slowdown"
  | "emergency_call_spike"
  | "hospital_arrivals_unusual"
  | "power_comms_load"
  | "citizen_report"
  | "heartbeat" // "I am alive" ping from a source
  | "gateway_heartbeat_lost" // a gateway stopped pinging (supports SENSOR_FAILURE)
  | "retraction"; // "ignore my earlier event X"

// Time is in whole simulated SECONDS since episode start.
// One tick = 60 s (see TICK_SECONDS). Phase 0 used minutes; Phase 1 switched to seconds.
export type Seconds = number;
export const TICK_SECONDS = 60;

// One raw observation, after the adapter has mapped it into our schema.
export interface Event {
  id: string;
  source_id: string;
  source_type: SourceType;
  gateway_id?: string; // sensors behind the same gateway share failures
  zone_id: string;
  kind: EventKind;
  value?: number; // e.g. rain mm/h, queue length
  reported_severity?: number; // 0..1 as claimed by the source
  occurred_at: Seconds; // source's own clock (may be skewed, R9; can even be > arrived_at)
  arrived_at: Seconds; // engine clock: when the engine received it (R8 uses this)
  retracts?: string; // id of an event this one cancels
  text?: string; // citizen text: DATA ONLY, never instructions
  narrative_id?: string; // rumor/narrative cluster tag
}

// What the engine knows about a source. No hidden truth here.
export interface SourceRegistryEntry {
  source_id: string;
  source_type: SourceType;
  zone_id: string;
  gateway_id?: string;
  heartbeat_interval_s: Seconds; // how often it normally says "I am alive"
  nominal_latency_s: Seconds; // typical delay between event and arrival
}

export interface Zone {
  zone_id: string;
  name: string;
  neighbours: string[]; // zone ids that touch this one (cascades spread along these)
}

export interface Gateway {
  gateway_id: string;
  zone_ids: string[]; // zones whose sensors relay through this gateway
}

// The PUBLIC description of the city the engine may see. The simulator's
// hidden version (true reliability, clock offsets) lives in sim/truth.ts.
export interface PublicRegistry {
  zones: Zone[];
  gateways: Gateway[];
  sources: SourceRegistryEntry[];
}

// Status of a source as seen by the engine at one tick (R5).
//   live  : heard from within 2x its heartbeat interval
//   stale : silent for 2x..4x its interval
//   dark  : silent for 4x+, or its gateway was reported lost
export type SourceStatus = "live" | "stale" | "dark";

export interface SourceSummary {
  live: number;
  stale: number;
  dark: number;
  total: number;
  coverage: number; // live / total, 0..1
}

// An event that failed validation. Kept for the dashboard, never used as evidence.
export interface QuarantinedEvent {
  event: Event;
  reason: string;
}

// An event as the filter sees it: ordered, with a skew-corrected time and
// whether its causal predecessor was already seen (see engine/order.ts).
export interface CleanedEvent extends Event {
  adjusted_occurred_at: Seconds; // occurred_at minus the source's estimated clock offset
  chained: boolean; // an upstream event (e.g. drainage before traffic) came earlier in the window
  fresh: boolean; // arrived since the last tick that ran the filter (scored this tick)
}

// One forecast line: "event X likely between p10 and p90" (R3).
// Times are ABSOLUTE engine seconds (same clock as tick_time), not "minutes from now".
export interface ForecastItem {
  kind: EventKind;
  probability: number; // P(cascade) x pass-through along the causal chain
  window_p10: Seconds;
  window_p90: Seconds;
  expected_at: Seconds; // the mean of the window
  zones: string[]; // zones where the upstream stage was seen
}

// Evidence after clustering and grouping (Phase 3, engine/grouping.ts).
// The filter scores UNITS, not raw events: 25 copies of one story = one unit.
//   single             one event that matched nothing else
//   near_duplicate     same zone + kind within 3 min, weight 1 + ln(n)
//   gateway_correlated identical values from many sensors of one gateway (favors SENSOR_FAILURE)
//   narrative          citizen reports sharing a narrative_id (capped unless corroborated)
export type UnitType = "single" | "near_duplicate" | "gateway_correlated" | "narrative";

export interface EvidenceUnit {
  unit_id: string;
  unit_type: UnitType;
  kind: EventKind;
  zone_id: string;
  n: number; // member events (after retractions)
  weight: number; // how many "independent events" this unit is worth
  strong: boolean; // some member passed the severity gate
  chained: boolean; // some member had its causal predecessor earlier (config/likelihoods.ts)
  trust: number; // mean source trust of the members
  value?: number; // representative value (median of members)
  first_t: Seconds; // earliest skew-adjusted occurred_at of a member
  last_t: Seconds;
  last_arrived_at: Seconds;
  gateway_id?: string;
  narrative_id?: string;
  corroborated?: boolean; // narrative only
  surge?: boolean; // near_duplicate only: too varied to be one incident, not discounted
  common_cause?: string; // set when the weight was discounted as part of one weather event (engine/grouping.ts)
  hypothesis_contributions: Record<Hypothesis, number>; // log-likelihood row it adds (weight already applied)
  source_unit_ids: string[]; // member event ids, for explanation tracing
  sources: string[]; // distinct source ids of the members
}

// One evidence contribution, for explanations (R7).
export interface EvidenceContribution {
  unit_id: string;
  description: string; // "3 drainage_anomaly reports in z03 (near-duplicate cluster)"
  kind: EventKind | "forecast";
  zone_id?: string;
  llr: number; // log-likelihood ratio, CASCADE vs the rest (positive = toward cascade)
  supports: Hypothesis; // the hypothesis this unit pushes up the most
}

export interface Explanation {
  top_evidence: EvidenceContribution[]; // top 3 by |llr|
  delta_summary: string; // what changed since the last tick, and why
  forecast_summary: string;
}

// Per-source learned trust, Beta(alpha, beta) (R4).
export interface TrustSnapshot {
  source_id: string;
  source_type: SourceType;
  alpha: number;
  beta: number;
  mean: number; // alpha / (alpha + beta)
}

// Everything the engine outputs for one simulated minute.
export interface TickRecord {
  tick_time: Seconds;
  probabilities: ProbabilityVector; // the posterior after calibration widening
  action: Action;
  expected_cost: number; // expected cost of the recommended action
  expected_costs: Record<Action, number>;
  forecast: ForecastItem[]; // next 3 events
  explanation: Explanation; // top 3 evidence, what changed, forecast in words (R7)
  evidence_units: number; // units with evidence in the current window (debugging)
  clusters: number; // of those, units holding 2+ events
  degraded: boolean; // R5: sources went dark, uncertainty widened
  fallback: boolean; // R11: main engine failed, baseline used
  source_statuses: Record<string, SourceStatus>;
  source_summary: SourceSummary;
  trust: TrustSnapshot[];
  retroactive_revisions: string[]; // late events that would have changed a past tick
  quarantined: QuarantinedEvent[]; // malformed events rejected this tick, with the reason
  unparsed: number; // raw events the adapter could not map at all (null), this tick
}
