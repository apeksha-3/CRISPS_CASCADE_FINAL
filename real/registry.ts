// real/registry.ts
// The PUBLIC registry for the real city: 10 zones, 6 SYNTHETIC gateways, and one source per
// feed channel. No hidden fields (there is no truth to hide in real data).
//
//   rain-<station>   rain_gauge      3 ASOS stations, placed in the nearest zone      heartbeat with every 5-min report
//   trf-<link>       traffic_sensor  each DOT link inside a zone (nearest centroid)   heartbeat with every valid report
//   col-<zone>       traffic_sensor  collisions of the zone (an event log)            long interval, no invented heartbeats
//   cit-<zone>       citizen_report  ONE anonymous source per community board (311)   long interval
//   utl-<zone>       utility         311 ELECTRIC complaints (weak power proxy)       long interval
//   dsp-<zone>       dispatch        EMS calls of the district                        long interval
//   hsp-<zone>       hospital        EMS hospital arrivals, placed in the INCIDENT's district  long interval
// Sensors (rain, traffic links) sit behind their zone's synthetic gateway; logs and feeds do not,
// as in the simulator.

import type { Gateway, PublicRegistry, SourceRegistryEntry, SourceType } from "../engine/types";
import { firstPoint, nearestZone, type RealZone } from "./geo";
import { HEARTBEAT_S, NOMINAL_LATENCY_S } from "./params";

// ASOS station positions (public metadata), used only to put each gauge in the nearest zone.
export const STATIONS = {
  NYC: { id: "rain-nyc", lat: 40.7789, lon: -73.9692, name: "Central Park (KNYC)" },
  JFK: { id: "rain-jfk", lat: 40.6386, lon: -73.7622, name: "JFK Airport (KJFK)" },
  LGA: { id: "rain-lga", lat: 40.7772, lon: -73.8726, name: "LaGuardia Airport (KLGA)" },
} as const;

export interface RealRegistry extends PublicRegistry {
  gateways: (Gateway & { synthetic: true })[];
}

export interface LinkInfo {
  link_id: string;
  zone_id: string;
}

// Which zone each DOT link belongs to. Links beyond LINK_MAX_KM of every centroid are left out (and counted).
export function linkZones(links: Record<string, string>[], zones: RealZone[]): { mapped: Map<string, string>; outside: number; noCoords: number } {
  const mapped = new Map<string, string>();
  let outside = 0;
  let noCoords = 0;
  for (const l of links.slice().sort((a, b) => (a.link_id < b.link_id ? -1 : 1))) {
    if (mapped.has(l.link_id)) continue;
    const p = firstPoint(l.link_points);
    if (!p) {
      noCoords++;
      continue;
    }
    const z = nearestZone(zones, p.lat, p.lon);
    if (z) mapped.set(l.link_id, z);
    else outside++;
  }
  return { mapped, outside, noCoords };
}

export function stationZones(zones: RealZone[]): Record<keyof typeof STATIONS, string> {
  const out = {} as Record<keyof typeof STATIONS, string>;
  for (const [k, s] of Object.entries(STATIONS)) out[k as keyof typeof STATIONS] = nearestZone(zones, s.lat, s.lon, Infinity)!;
  return out;
}

export function buildRegistry(zones: RealZone[], links: Record<string, string>[]): RealRegistry {
  const gw = new Map(zones.map((z) => [z.zone_id, z.gateway_id]));
  const sources: SourceRegistryEntry[] = [];
  const add = (source_id: string, source_type: SourceType, zone_id: string, interval: number, gateway = false) => {
    const s: SourceRegistryEntry = { source_id, source_type, zone_id, heartbeat_interval_s: interval, nominal_latency_s: NOMINAL_LATENCY_S[source_type] };
    if (gateway) s.gateway_id = gw.get(zone_id);
    sources.push(s);
  };
  const sz = stationZones(zones);
  for (const [k, s] of Object.entries(STATIONS)) add(s.id, "rain_gauge", sz[k as keyof typeof STATIONS], HEARTBEAT_S.rain_gauge, true);
  const { mapped } = linkZones(links, zones);
  for (const [id, z] of [...mapped.entries()].sort()) add(`trf-${id}`, "traffic_sensor", z, HEARTBEAT_S.traffic_sensor, true);
  for (const z of zones) {
    add(`col-${z.zone_id}`, "traffic_sensor", z.zone_id, HEARTBEAT_S.event_log);
    add(`cit-${z.zone_id}`, "citizen_report", z.zone_id, HEARTBEAT_S.event_log);
    add(`utl-${z.zone_id}`, "utility", z.zone_id, HEARTBEAT_S.event_log);
    add(`dsp-${z.zone_id}`, "dispatch", z.zone_id, HEARTBEAT_S.event_log);
    add(`hsp-${z.zone_id}`, "hospital", z.zone_id, HEARTBEAT_S.event_log);
  }
  const gateways = [...new Set(zones.map((z) => z.gateway_id))].sort().map((gateway_id) => ({
    gateway_id,
    zone_ids: zones.filter((z) => z.gateway_id === gateway_id).map((z) => z.zone_id).sort(),
    synthetic: true as const,
  }));
  return {
    zones: zones.map((z) => ({ zone_id: z.zone_id, name: z.name, neighbours: z.neighbours })),
    gateways,
    sources,
  };
}
