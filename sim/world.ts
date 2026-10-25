// sim/world.ts
// Builds the city once per episode from the seed: zones with neighbours,
// gateways, and ~100 sources with hidden reliability and clock offsets.

import type { Gateway, SourceType, Zone } from "../engine/types";
import {
  CLOCK_OFFSET_MAX_S,
  HEARTBEAT,
  NOMINAL_LATENCY_S,
  RELIABILITY,
  WORLD,
} from "./params";
import { Rng } from "./rng";
import type { SimSourceEntry, SimWorld } from "./truth";

const SHORT: Record<SourceType, string> = {
  rain_gauge: "rain",
  drainage_sensor: "drn",
  traffic_sensor: "trf",
  camera: "cam",
  utility: "utl",
  dispatch: "dsp",
  hospital: "hsp",
  citizen_report: "cit",
  gateway: "gw",
};

// Sensors sit behind gateways; dispatch, hospitals and citizens do not.
const GATEWAY_TYPES: SourceType[] = ["rain_gauge", "drainage_sensor", "traffic_sensor", "camera", "utility"];

export function buildWorld(rng: Rng): SimWorld {
  // Zones on a ring (each touches the next), plus a few random shortcuts.
  const n = WORLD.zones;
  const ids = Array.from({ length: n }, (_, i) => `z${String(i).padStart(2, "0")}`);
  const nb: Set<string>[] = ids.map(() => new Set());
  const link = (a: number, b: number) => {
    if (a === b) return;
    nb[a].add(ids[b]);
    nb[b].add(ids[a]);
  };
  for (let i = 0; i < n; i++) link(i, (i + 1) % n);
  for (let k = 0; k < WORLD.extra_neighbour_links; k++) link(rng.int(0, n - 1), rng.int(0, n - 1));
  const zones: Zone[] = ids.map((zone_id, i) => ({
    zone_id,
    name: WORLD.zone_names[i],
    neighbours: [...nb[i]].sort(),
  }));

  // Gateways: gateway 0 relays 3 zones (the "big" one), the rest split the others.
  const order = rng.shuffle(ids);
  const groups: string[][] = [order.slice(0, WORLD.big_gateway_zones)];
  const rest = order.slice(WORLD.big_gateway_zones);
  const others = WORLD.gateways - 1;
  for (let g = 0; g < others; g++) groups.push([]);
  rest.forEach((z, i) => groups[1 + (i % others)].push(z));
  const gateways: Gateway[] = groups.map((zs, g) => ({ gateway_id: `gw${g}`, zone_ids: zs.slice().sort() }));
  const gatewayOf = new Map<string, string>();
  for (const g of gateways) for (const z of g.zone_ids) gatewayOf.set(z, g.gateway_id);

  const sources: SimSourceEntry[] = [];
  const counters: Record<string, number> = {};
  const add = (type: SourceType, zone_id: string, behindGateway: boolean) => {
    const key = `${SHORT[type]}-${zone_id}`;
    counters[key] = (counters[key] ?? 0) + 1;
    const [lo, hi] = RELIABILITY[type];
    const s: SimSourceEntry = {
      source_id: type === "citizen_report" ? `${SHORT[type]}-${String(sources.length).padStart(3, "0")}` : `${key}-${counters[key]}`,
      source_type: type,
      zone_id,
      heartbeat_interval_s: HEARTBEAT.interval_s,
      nominal_latency_s: NOMINAL_LATENCY_S[type],
      true_reliability: round3(rng.range(lo, hi)),
      clock_offset: Math.round(rng.range(-CLOCK_OFFSET_MAX_S, CLOCK_OFFSET_MAX_S)),
    };
    if (behindGateway) s.gateway_id = gatewayOf.get(zone_id);
    sources.push(s);
  };

  for (const z of ids) {
    for (const type of GATEWAY_TYPES) {
      const [lo, hi] = WORLD.sensors_per_zone[type];
      const count = rng.int(lo, hi);
      for (let k = 0; k < count; k++) add(type, z, true);
    }
  }
  // Make sure the big gateway carries enough sensors (the R5 "one outage masks many" case).
  const big = gateways[0];
  let i = 0;
  while (sources.filter((s) => s.gateway_id === big.gateway_id).length < WORLD.big_gateway_min_sensors) {
    add("traffic_sensor", big.zone_ids[i++ % big.zone_ids.length], true);
  }
  for (let k = 0; k < WORLD.dispatch_lines; k++) add("dispatch", rng.pick(ids), false);
  const hospitalZones = rng.shuffle(ids).slice(0, rng.int(WORLD.hospitals[0], WORLD.hospitals[1]));
  for (const z of hospitalZones.sort()) add("hospital", z, false);
  for (let k = 0; k < WORLD.citizen_sources; k++) add("citizen_report", rng.pick(ids), false);

  return { zones, gateways, sources };
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function sourcesOfType(world: SimWorld, type: SourceType, zone_id?: string): SimSourceEntry[] {
  return world.sources.filter((s) => s.source_type === type && (zone_id === undefined || s.zone_id === zone_id));
}

// The hospital in this zone, or the first one in a neighbour zone, or any.
export function nearestHospital(world: SimWorld, zone_id: string): SimSourceEntry {
  const hs = sourcesOfType(world, "hospital");
  const here = hs.find((h) => h.zone_id === zone_id);
  if (here) return here;
  const nbs = world.zones.find((z) => z.zone_id === zone_id)!.neighbours;
  return hs.find((h) => nbs.includes(h.zone_id)) ?? hs[0];
}
