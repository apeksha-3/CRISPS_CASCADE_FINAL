// engine/baseline.ts
// The naive count-threshold baseline. A pure function: same events + same time
// => same answer. It is our comparison point in eval AND, from Phase 3 on,
// the safe FALLBACK when the main engine throws (R11).
//
// Rule: count distinct anomaly events (not heartbeats, not retracted, deduped
// by id) that arrived in the last 5 minutes, and map the count to an action.
// It only ever looks at events with arrived_at <= now (R8). No ground truth.

import { BASELINE_KNOBS as K } from "../config/knobs";
import { type Action, type Event, type EventKind, HYPOTHESES, type Hypothesis, type Seconds } from "./types";

// Kinds that mean "something looks wrong". Heartbeats, retractions and the
// gateway monitor's "heartbeat lost" are about the sensors, not the city.
export const ANOMALY_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "rain_heavy",
  "drainage_anomaly",
  "traffic_slowdown",
  "emergency_call_spike",
  "hospital_arrivals_unusual",
  "power_comms_load",
  "citizen_report",
]);

export interface BaselineOutput {
  action: Action;
  probabilities: Record<Hypothesis, number>;
  count: number; // anomalies in the window
  pending_retractions: number; // retractions whose target has not arrived (yet)
}

export interface CleanStream {
  events: Event[]; // distinct, non-retracted, in arrival order
  pendingRetractions: Set<string>;
}

// Walk the visible events in arrival order, keeping:
//   seen      - ids already accepted (a second copy with the same id is a duplicate)
//   retracted - ids cancelled by a retraction
//   pending   - retractions whose target has not arrived yet (orphans). When the
//               target shows up later it is treated as already retracted.
// Whatever is still pending at the end of the episode is simply discarded.
export function cleanStream(events: Event[], now: Seconds): CleanStream {
  const visible = events
    .filter((e) => e && Number.isFinite(e.arrived_at) && e.arrived_at <= now)
    .slice()
    .sort((a, b) => a.arrived_at - b.arrived_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Map<string, Event>();
  const retracted = new Set<string>();
  const pending = new Set<string>();
  for (const e of visible) {
    if (e.kind === "retraction") {
      if (!e.retracts) continue;
      if (seen.has(e.retracts)) retracted.add(e.retracts);
      else pending.add(e.retracts);
      continue;
    }
    if (seen.has(e.id)) continue; // duplicate retransmission
    seen.set(e.id, e);
    if (pending.has(e.id)) {
      retracted.add(e.id); // its retraction arrived first
      pending.delete(e.id);
    }
  }
  return { events: [...seen.values()].filter((e) => !retracted.has(e.id)), pendingRetractions: pending };
}

export function countThresholdBaseline(events: Event[], now: Seconds): BaselineOutput {
  const clean = cleanStream(events, now);
  const from = now - K.window_seconds;
  const count = clean.events.filter((e) => ANOMALY_KINDS.has(e.kind) && e.arrived_at > from).length;
  const action: Action =
    count >= K.escalate_at ? "ESCALATE" : count >= K.alert_at ? "ALERT" : count >= K.prepare_at ? "PREPARE" : "WATCH";
  const row = K.bucket_probabilities[action];
  const probabilities = Object.fromEntries(HYPOTHESES.map((h, i) => [h, row[i]])) as Record<Hypothesis, number>;
  return { action, probabilities, count, pending_retractions: clean.pendingRetractions.size };
}
