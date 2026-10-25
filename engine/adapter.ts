// engine/adapter.ts
// The ONE place that maps an outside event format into our Event type.
// To plug in another schema (e.g. the organizers'), add its field names to
// FIELD_ALIASES below; nothing else in the engine changes.
//
// The adapter only MAPS: it renames fields and coerces types ("42" -> 42).
// It does not judge. A mapped event with a missing or broken field is still
// returned; the validator (engine/validate.ts) decides whether to quarantine it.
// It returns null only when the input is not an event at all (unknown schema).
// Pure function: no clock, no state.

import type { Event } from "./types";

// Our field name -> names it may have in other schemas (first match wins).
const FIELD_ALIASES: Record<keyof Event, string[]> = {
  id: ["id", "event_id", "eventId", "uuid"],
  source_id: ["source_id", "sourceId", "source", "sensor_id"],
  source_type: ["source_type", "sourceType", "source_kind"],
  gateway_id: ["gateway_id", "gatewayId", "gateway"],
  zone_id: ["zone_id", "zoneId", "zone", "district"],
  kind: ["kind", "event_type", "eventType", "type"],
  value: ["value", "reading", "measurement"],
  reported_severity: ["reported_severity", "severity", "reportedSeverity"],
  occurred_at: ["occurred_at", "occurredAt", "event_time", "timestamp"],
  arrived_at: ["arrived_at", "arrivedAt", "received_at", "ingest_time"],
  retracts: ["retracts", "retracts_id", "cancels"],
  text: ["text", "message", "body"],
  narrative_id: ["narrative_id", "narrativeId", "cluster_id"],
};

const NUMBER_FIELDS = new Set<keyof Event>(["value", "reported_severity", "occurred_at", "arrived_at"]);
const STRING_FIELDS = new Set<keyof Event>(["id", "source_id", "source_type", "gateway_id", "zone_id", "kind", "retracts", "text", "narrative_id"]);

function pick(raw: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) if (raw[n] !== undefined && raw[n] !== null) return raw[n];
  return undefined;
}

// "42" -> 42, 42 -> 42, "abc" -> NaN (the validator will catch NaN).
function toNumber(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "string" && x.trim() !== "") return Number(x);
  return Number.NaN;
}

export function adaptEvent(raw: unknown): Event | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  // Not even an id or a kind: we cannot tell what this is.
  if (pick(r, FIELD_ALIASES.id) === undefined && pick(r, FIELD_ALIASES.kind) === undefined) return null;

  const out: Record<string, unknown> = {};
  for (const field of Object.keys(FIELD_ALIASES) as (keyof Event)[]) {
    const v = pick(r, FIELD_ALIASES[field]);
    if (v === undefined) continue;
    if (NUMBER_FIELDS.has(field)) out[field] = toNumber(v);
    else if (STRING_FIELDS.has(field)) out[field] = typeof v === "string" ? v : String(v);
  }
  // Cast: fields may still be missing here. validateEvent checks them.
  return out as unknown as Event;
}
