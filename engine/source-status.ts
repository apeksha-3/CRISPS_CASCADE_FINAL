// engine/source-status.ts
// Is each registered source live, stale or dark? (R5)
//   live  : heard from (any event, heartbeat or not) within 2x its heartbeat interval
//   stale : silent between 2x and 4x the interval
//   dark  : silent 4x+ the interval, OR a gateway_heartbeat_lost for its gateway
//           arrived after the last time we heard from it
// "Heard from" uses arrived_at: the engine's own clock.
// At engine start every source counts as just heard from (time 0), so the
// first minutes are not mistaken for a mass outage.
// coverage() = live sources / registered sources. It drives calibration widening.

import { KNOBS } from "../config/knobs";
import type { Event, PublicRegistry, Seconds, SourceStatus, SourceSummary } from "./types";

export class SourceTracker {
  private lastHeard = new Map<string, Seconds>();
  private gatewayLostAt = new Map<string, Seconds>();

  constructor(private registry: PublicRegistry, startTime: Seconds = 0) {
    for (const s of registry.sources) this.lastHeard.set(s.source_id, startTime);
  }

  observe(e: Event): void {
    if (e.kind === "gateway_heartbeat_lost") {
      const gw = e.gateway_id ?? e.source_id; // the monitor reports as the gateway itself
      this.gatewayLostAt.set(gw, Math.max(this.gatewayLostAt.get(gw) ?? -Infinity, e.arrived_at));
      return;
    }
    if (!this.lastHeard.has(e.source_id)) return; // not a registered source
    this.lastHeard.set(e.source_id, Math.max(this.lastHeard.get(e.source_id)!, e.arrived_at));
  }

  statuses(now: Seconds): Record<string, SourceStatus> {
    const out: Record<string, SourceStatus> = {};
    for (const s of this.registry.sources) {
      const last = this.lastHeard.get(s.source_id)!;
      const silent = now - last;
      const lost = s.gateway_id !== undefined && (this.gatewayLostAt.get(s.gateway_id) ?? -Infinity) >= last;
      if (lost || silent >= KNOBS.dark_after_intervals * s.heartbeat_interval_s) out[s.source_id] = "dark";
      else if (silent >= KNOBS.stale_after_intervals * s.heartbeat_interval_s) out[s.source_id] = "stale";
      else out[s.source_id] = "live";
    }
    return out;
  }

  coverage(now: Seconds): number {
    return summarize(this.statuses(now)).coverage;
  }
}

export function summarize(statuses: Record<string, SourceStatus>): SourceSummary {
  const all = Object.values(statuses);
  const count = (x: SourceStatus) => all.filter((s) => s === x).length;
  const live = count("live");
  return { live, stale: count("stale"), dark: count("dark"), total: all.length, coverage: all.length ? live / all.length : 1 };
}

// Trust-weighted coverage (Phase 4): each source counts with its weight (its type's
// mean trust), so losing a few high-trust hospitals and rain gauges lowers coverage
// more than losing many low-trust citizen channels.
//   coverage = sum of weights of LIVE sources / sum of weights of ALL sources
export function weightedCoverage(statuses: Record<string, SourceStatus>, weights: Record<string, number>): number {
  let live = 0;
  let total = 0;
  for (const [id, st] of Object.entries(statuses)) {
    const w = weights[id] ?? 1;
    total += w;
    if (st === "live") live += w;
  }
  return total > 0 ? live / total : 1;
}
