// engine/order.ts
// Build the "cleaned window": the evidence the filter sees this tick.
//
//   1. take active (not retracted, deduped) events that ARRIVED in the last
//      window_s seconds (arrived_at <= now always holds: the log refuses the future)
//   2. correct each source's clock: adjusted = occurred_at - estimated offset.
//      Phase 2 uses the registry's nominal_latency_s as the first estimate;
//      Phase 4 learns per-source offsets (R9).
//   3. sort by adjusted time (ties by id, so the order is deterministic)
//   4. mark each event `chained` if its causal predecessor (config/likelihoods.ts
//      `upstream`) was seen EARLIER in the window (for hospitals since Phase 4: 2+
//      calls from one zone, not scattered calls), and `fresh` if it has not been
//      scored by the filter yet. Readings flagged as a lying gateway
//      (engine/grouping.ts) never count as a predecessor.
// Heartbeats and retractions are bookkeeping, not evidence, so they are left out.

import { LIKELIHOODS, SEVERITY_GATE } from "../config/likelihoods";
import type { EventLog } from "./log";
import type { CleanedEvent, Event, PublicRegistry, Seconds } from "./types";

export function offsetEstimates(registry: PublicRegistry): Map<string, Seconds> {
  return new Map(registry.sources.map((s) => [s.source_id, s.nominal_latency_s]));
}

export const isStrong = (e: Event) => (e.reported_severity ?? 1) >= SEVERITY_GATE.strong;

export function buildCleanedWindow(
  log: EventLog,
  offsets: Map<string, Seconds>,
  now: Seconds,
  windowS: Seconds,
  scored: { has(id: string): boolean }, // ids the filter already scored
  notContext: { has(id: string): boolean } = new Set<string>(), // e.g. a lying gateway's readings: never a causal predecessor
): CleanedEvent[] {
  const evidence = log.activeEvents(now - windowS, now).filter((e) => e.kind !== "heartbeat" && e.kind !== "retraction");
  const cleaned: CleanedEvent[] = evidence.map((e) => ({
    ...e,
    adjusted_occurred_at: e.occurred_at - (offsets.get(e.source_id) ?? 0),
    chained: false,
    fresh: !scored.has(e.id),
  }));
  cleaned.sort((a, b) => a.adjusted_occurred_at - b.adjusted_occurred_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Causal context: count strong predecessor events that came strictly earlier.
  for (const e of cleaned) {
    const up = LIKELIHOODS[e.kind]?.upstream;
    if (!up) continue;
    const perZone = new Map<string, number>(); // predecessors counted per zone
    for (const u of cleaned) {
      if (u.adjusted_occurred_at >= e.adjusted_occurred_at) break; // sorted: nothing earlier after this
      if (!up.kinds.includes(u.kind) || !isStrong(u) || notContext.has(u.id)) continue;
      if (up.scope === "zone" && u.zone_id !== e.zone_id) continue;
      perZone.set(u.zone_id, (perZone.get(u.zone_id) ?? 0) + 1);
    }
    const counts = [...perZone.values()];
    const n = up.scope === "one_zone" ? Math.max(0, ...counts) : counts.reduce((a, b) => a + b, 0);
    e.chained = n >= up.min;
  }
  return cleaned;
}
