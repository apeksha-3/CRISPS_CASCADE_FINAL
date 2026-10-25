// tests/helpers.ts
// A tiny hand-made city for engine unit tests (no simulator needed).

import type { CleanedEvent, Event, PublicRegistry } from "../engine/types";

export const REGISTRY: PublicRegistry = {
  zones: [
    { zone_id: "z0", name: "Harbor", neighbours: ["z1"] },
    { zone_id: "z1", name: "Old Town", neighbours: ["z0"] },
  ],
  gateways: [{ gateway_id: "gw0", zone_ids: ["z0"] }],
  sources: [
    { source_id: "rain0", source_type: "rain_gauge", zone_id: "z0", gateway_id: "gw0", heartbeat_interval_s: 300, nominal_latency_s: 15 },
    { source_id: "drain0", source_type: "drainage_sensor", zone_id: "z0", gateway_id: "gw0", heartbeat_interval_s: 300, nominal_latency_s: 20 },
    { source_id: "traf0", source_type: "traffic_sensor", zone_id: "z0", gateway_id: "gw0", heartbeat_interval_s: 300, nominal_latency_s: 15 },
    { source_id: "disp0", source_type: "dispatch", zone_id: "z0", heartbeat_interval_s: 300, nominal_latency_s: 30 },
    { source_id: "hosp1", source_type: "hospital", zone_id: "z1", heartbeat_interval_s: 300, nominal_latency_s: 60 },
    { source_id: "cit0", source_type: "citizen_report", zone_id: "z1", heartbeat_interval_s: 300, nominal_latency_s: 60 },
  ],
};

let n = 0;
export function ev(extra: Partial<Event> & Pick<Event, "arrived_at">): Event {
  n++;
  return {
    id: `t${n}`,
    source_id: "traf0",
    source_type: "traffic_sensor",
    zone_id: "z0",
    kind: "traffic_slowdown",
    occurred_at: extra.arrived_at - 10,
    reported_severity: 0.8,
    ...extra,
  };
}

// A cleaned event (as engine/order.ts would produce it), for cluster / grouping tests.
export function ce(extra: Partial<CleanedEvent> & Pick<Event, "arrived_at">): CleanedEvent {
  const e = ev(extra);
  return { adjusted_occurred_at: e.occurred_at, chained: false, fresh: true, ...e, ...extra } as CleanedEvent;
}
