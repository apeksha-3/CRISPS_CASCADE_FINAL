// config/causal-graph.ts
// Causal chain used for forecasting (R3):
// rain -> drainage -> traffic -> emergency calls -> hospital arrivals -> power/comms load
//
// Each edge says: "if the upstream stage started at time t, the downstream stage
// usually starts lag.mean seconds later, give or take lag.sd", and pass_through is
// the chance a cascade actually reaches the next stage (not every flood blocks roads).
// Phases 2-3 used hand-set lags copied from the simulator's own stage lags
// (HANDSET_LAGS below). Since Phase 4 each edge uses the lag MEASURED on dev
// cascade episodes by `npm run tune -- --split dev` (config/lags.ts), and falls
// back to the hand-set lag if an edge was never measured. Swap in a different
// data source and the lags update with it.
// pass_through stays hand-set.

import type { EventKind } from "../engine/types";
import { LEARNED_LAGS } from "./lags";

export interface CausalEdge {
  from: EventKind;
  to: EventKind;
  lag: { mean: number; sd: number }; // SECONDS
  pass_through: number; // P(downstream stage happens | upstream happened, cascade)
}

export const CAUSAL_ORDER: EventKind[] = [
  "rain_heavy",
  "drainage_anomaly",
  "traffic_slowdown",
  "emergency_call_spike",
  "hospital_arrivals_unusual",
  "power_comms_load",
];

// The hand-set lags (key = the downstream stage). The hospital -> power edge was
// our approximation: in the simulator power load follows the calls ~4.5 min later.
export const HANDSET_LAGS: Partial<Record<EventKind, { mean: number; sd: number }>> = {
  drainage_anomaly: { mean: 180, sd: 60 },
  traffic_slowdown: { mean: 120, sd: 45 },
  emergency_call_spike: { mean: 120, sd: 45 },
  hospital_arrivals_unusual: { mean: 150, sd: 60 },
  power_comms_load: { mean: 120, sd: 90 },
};

const PASS_THROUGH: Partial<Record<EventKind, number>> = {
  drainage_anomaly: 0.9,
  traffic_slowdown: 0.9,
  emergency_call_spike: 0.85,
  hospital_arrivals_unusual: 0.85,
  power_comms_load: 0.7,
};

const lagInto = (to: EventKind) => {
  const l = LEARNED_LAGS[to] ?? HANDSET_LAGS[to]!;
  return { mean: l.mean, sd: l.sd };
};

export const CAUSAL_EDGES: CausalEdge[] = CAUSAL_ORDER.slice(1).map((to, i) => ({
  from: CAUSAL_ORDER[i],
  to,
  lag: lagInto(to),
  pass_through: PASS_THROUGH[to]!,
}));
