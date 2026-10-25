// engine/validate.ts
// Check one event is well-formed. Bad events are QUARANTINED with a reason:
// kept aside for the dashboard, never used as evidence, never fatal (R5).
// Pure function.
//
// NOT a reason to quarantine: occurred_at > arrived_at. That is a source whose
// clock runs fast (clock skew, R9), which is a signal, not corruption.

import { type Event, type EventKind, type Seconds } from "./types";

export const KNOWN_KINDS: readonly EventKind[] = [
  "rain_heavy",
  "drainage_anomaly",
  "traffic_slowdown",
  "emergency_call_spike",
  "hospital_arrivals_unusual",
  "power_comms_load",
  "citizen_report",
  "heartbeat",
  "gateway_heartbeat_lost",
  "retraction",
];

export interface ValidateContext {
  now: Seconds; // engine clock
  zones: ReadonlySet<string>; // zone ids from the public registry
  knownKinds?: ReadonlySet<string>; // defaults to KNOWN_KINDS
}

export type ValidationResult = { valid: Event } | { quarantined: Event; reason: string };

const REQUIRED: (keyof Event)[] = ["id", "source_id", "source_type", "kind", "arrived_at"];
const NUMERIC: (keyof Event)[] = ["occurred_at", "arrived_at", "value", "reported_severity"];
const DEFAULT_KINDS: ReadonlySet<string> = new Set(KNOWN_KINDS);

export function validateEvent(e: Event, ctx: ValidateContext): ValidationResult {
  const bad = (reason: string): ValidationResult => ({ quarantined: e, reason });
  for (const f of REQUIRED) {
    const v = e[f];
    if (v === undefined || v === null || v === "") return bad(`missing ${f}`);
  }
  for (const f of NUMERIC) {
    const v = e[f];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) return bad(`${f} is not a finite number`);
  }
  if (e.arrived_at > ctx.now) return bad("arrived_at is in the future");
  if (!(ctx.knownKinds ?? DEFAULT_KINDS).has(e.kind)) return bad(`unknown kind "${e.kind}"`);
  // Retractions and heartbeats are about a source, not a place, so a zone is optional for them.
  const needsZone = e.kind !== "retraction" && e.kind !== "heartbeat";
  if (needsZone && e.zone_id === undefined) return bad("missing zone_id");
  if (e.zone_id !== undefined && !ctx.zones.has(e.zone_id)) return bad(`unknown zone "${e.zone_id}"`);
  if (e.kind === "retraction" && !e.retracts) return bad("retraction without a target id");
  return { valid: e };
}
