// config/knobs.ts
// Decision and robustness knobs. All hand-set, tune later.

export const KNOBS = {
  // Hysteresis (R6)
  escalate_consecutive_ticks: 2, // optimal action must be higher for 2 ticks in a row
  deescalate_consecutive_ticks: 4, // ...and lower for 4 ticks before stepping down
  // Step down one level only if P(cascade) is below the threshold for that step.
  deescalate_max_p_cascade: { ESCALATE: 0.5, ALERT: 0.3, PREPARE: 0.15 } as Record<string, number>,
  min_dwell_ticks: 3, // stay at least 3 ticks on any action
  fast_commit_p_cascade: 0.9, // above this, jump straight to ESCALATE

  // Clock skew tolerance when ordering events (R9). (Phase 3)
  skew_tolerance_minutes: 2,

  // Source status (R5), in multiples of the source's heartbeat interval:
  // live under 2x, stale 2x..4x, dark 4x+ (or its gateway reported lost).
  stale_after_intervals: 2,
  dark_after_intervals: 4,

  // Calibration temperature (fit on dev seeds later). 1 = no change.
  temperature: 1,

  // One-step lookahead (R2, engine/decide.ts). Defer an upgrade by one tick
  // when waiting is cheaper than acting by more than this many cost points.
  lookahead_margin: 0.25,
  lookahead_max_defer_ticks: 1, // never defer more than this many ticks in a row
  // Let a confident forecast count as one of the 2 "above" ticks hysteresis needs.
  lookahead_anticipate: true,
};

// Near-duplicate clustering (R10, engine/cluster.ts) and common-cause
// grouping (engine/grouping.ts). Phase 3.
export const CLUSTER_KNOBS = {
  // Same zone + same kind + occurred within this many seconds of an event already
  // in the cluster => same real-world incident (or the same weather event).
  near_dup_window_s: 180,
  // Surge protection: a cluster this big or bigger whose values are spread out
  // is a real surge of distinct incidents and is NOT discounted.
  surge_min_events: 30,
  // Copies of one report carry the same value (sd 0). On DEV, every real cluster
  // of 20+ events had a value sd between 4.2 and 12.9, so 3 separates them.
  surge_value_sd: 3,
  // Rain + drainage + traffic units of one zone count as ONE weather event (B2b).
  weather_common_cause: true,
  // Gateway perfect-correlation detector (B1)
  gateway_min_sensors: 3, // the gateway must relay at least this many registered sensors
  gateway_min_events: 5, // ...and at least this many fresh anomalies this tick
  gateway_value_epsilon: 0.05, // "identical" = all values within this of each other
  gateway_memory_s: 300, // later stragglers with the same value join the flagged group
  // Narrative clusters (B2): corroborated if a physical source (not a citizen)
  // in the same zone reports a clear anomaly within this many seconds.
  corroboration_window_s: 300,
  corroboration_min_severity: 0.6, // "clear anomaly": above every everyday blip
};

// Causal-chain forecast (engine/forecast.ts). Phase 3.
export const FORECAST_KNOBS = {
  window_z: 1.2816, // [p10, p90] = mean -/+ 1.2816 sd of a normal distribution
  // Extra time allowed after p90 before a forecast counts as missed: the stage
  // may have started on time, but its first event needs time to be reported.
  detection_slack_s: 120,
  // Seen times are first DETECTIONS, not true stage starts: each is late by a
  // random 1-3 min. The gap between two detections gets this much extra sd
  // (as two independent delays: variance + 2 x detection_sd^2).
  detection_sd_s: 90,
  stage_min_weight: 1, // a stage is "observed" once its strong, in-chain evidence weight reaches this
  confirm_bonus_ll: 0.3, // forecast confirmed: + this to CASCADE's log-likelihood
  confirm_bonus_downstream_ll: 1.0, // ...for hospital / power (stages weather alone never produces)
  // Forecast missed: CASCADE gets ln(1 - pass_through * coverage * miss_strength).
  miss_strength: 0.6,
  benign_threshold: 0.7, // P(NOISE) + P(SENSOR_FAILURE) above this => "no further escalation"
  reset_after_quiet_s: 15 * 60, // no in-chain evidence for this long => forget the chain
};

// Forward filter (engine/filter.ts) and tick runner (engine/tick.ts).
export const FILTER_KNOBS = {
  window_s: 15 * 60, // the cleaned window: events that arrived in the last 15 minutes
  // Trust tempering: each unit's log-likelihood is multiplied by the trust of its
  // sources (per-source Beta trust since Phase 4: engine/trust.ts, config/trust-priors.ts).
  // Silence: each tick, every dark source adds this much log-likelihood to
  // SENSOR_FAILURE (stale sources half of it). Capped per tick so a big outage
  // does not shout louder than the "gateway lost" event itself.
  silence_dark_ll: 0.02,
  silence_stale_ll: 0.01,
  silence_cap_ll: 0.3,
  // DEGRADED flag when TRUST-WEIGHTED live coverage drops below this (Phase 4: was 0.7
  // on a plain head count, and never fired; see engine/source-status.ts weightedCoverage).
  degraded_below_coverage: 0.5,
};

// Naive count-threshold baseline (engine/baseline.ts), also the future FALLBACK (R11).
// Count distinct, non-retracted anomaly events that ARRIVED in the last 5 minutes,
// then map the count to an action and a fixed probability vector.
// Thresholds hand-set by eyeballing DEV episodes only (never test).
export const BASELINE_KNOBS = {
  window_seconds: 300,
  prepare_at: 30, // >= 30 anomalies in 5 min -> PREPARE
  alert_at: 40, // >= 40 -> ALERT
  escalate_at: 55, // >= 55 -> ESCALATE
  // Probability vector per bucket [NOISE, SENSOR_FAILURE, ISOLATED_INCIDENT, CASCADING_CRISIS].
  // Simple rule of thumb: more anomalies => less NOISE, more CASCADE. Each row sums to 1.
  bucket_probabilities: {
    WATCH: [0.7, 0.12, 0.12, 0.06],
    PREPARE: [0.4, 0.15, 0.3, 0.15],
    ALERT: [0.2, 0.1, 0.35, 0.35],
    ESCALATE: [0.08, 0.07, 0.25, 0.6],
  },
};
