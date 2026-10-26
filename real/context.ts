// real/context.ts
// Everything the adapters need that is the same for every episode: the zones, the registry,
// the link table, the gateway map. Built from real/controls.json (written by scripts/real/fetch.ts)
// and the cached DOT link table.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adapt311 } from "./adapt-311";
import { adaptCollisions } from "./adapt-collisions";
import { adaptDot } from "./adapt-dot";
import { adaptEms } from "./adapt-ems";
import { adaptRain } from "./adapt-rain";
import { buildBaselines, type Baselines } from "./baselines";
import type { RealZone } from "./geo";
import { loadIem, loadJson, loadLinks } from "./load";
import { type Obs, Unmapped } from "./obs";
import { buildRegistry, linkZones, type RealRegistry, stationZones } from "./registry";
import { utcMsToLocalIso } from "./tz";

export interface Controls {
  rain: string[];
  dry: string[];
  ffw: Record<string, string>;
  zones: RealZone[];
}

export interface Context {
  controls: Controls;
  links: Record<string, string>[];
  zones: RealZone[];
  registry: RealRegistry;
  linkZone: Map<string, string>;
  gatewayOf: Map<string, string>;
  stationZone: Record<string, string>;
  linkStats: { mapped: number; outside: number; noCoords: number };
}

export function loadControls(): Controls {
  return JSON.parse(readFileSync(join(process.cwd(), "real", "controls.json"), "utf8")) as Controls;
}

export function loadContext(): Context {
  const controls = loadControls();
  const links = loadLinks();
  const lz = linkZones(links, controls.zones);
  return {
    controls,
    links,
    zones: controls.zones,
    registry: buildRegistry(controls.zones, links),
    linkZone: lz.mapped,
    gatewayOf: new Map(controls.zones.map((z) => [z.zone_id, z.gateway_id])),
    stationZone: stationZones(controls.zones),
    linkStats: { mapped: lz.mapped.size, outside: lz.outside, noCoords: lz.noCoords },
  };
}

// Which dataset window file holds a given local day?
export function windowOf(ctx: Context, day: string, cascadeWindows: { id: string; from: string; to: string }[]): string {
  const w = cascadeWindows.find((c) => day >= c.from && day < c.to);
  if (w) return w.id;
  if (ctx.controls.rain.includes(day)) return `rain-${day}`;
  if (ctx.controls.dry.includes(day)) return `dry-${day}`;
  throw new Error(`no fetched window holds ${day}`);
}

// All observations in [fromMs, toMs) from one fetched window, through every adapter.
export function observe(ctx: Context, windowId: string, fromMs: number, toMs: number, base: Baselines, unmapped: Unmapped, healthy?: Set<string>): Obs[] {
  const fromIso = utcMsToLocalIso(fromMs);
  const toIso = utcMsToLocalIso(toMs);
  const inRange = (rows: Record<string, string>[], field: string) => rows.filter((r) => r[field] >= fromIso && r[field] < toIso);
  const obs: Obs[] = [];
  obs.push(...adapt311(inRange(loadJson("311", windowId), "created_date"), ctx.zones, fromMs, toMs, unmapped));
  obs.push(...adaptDot(inRange(loadJson("dot-speeds", windowId), "data_as_of"), ctx.linkZone, ctx.gatewayOf, base, fromMs, toMs, unmapped, healthy));
  obs.push(...adaptEms(loadJson("ems", windowId).filter((r) => r.incident_datetime < toIso), ctx.zones, base, fromMs, toMs, unmapped));
  obs.push(...adaptCollisions(loadJson("collisions", windowId).filter((r) => r.crash_date.slice(0, 10) >= fromIso.slice(0, 10) && r.crash_date.slice(0, 10) <= toIso.slice(0, 10)), ctx.zones, fromMs, toMs, unmapped));
  obs.push(...adaptRain(loadIem(windowId), ctx.stationZone, ctx.gatewayOf, fromMs, toMs, unmapped));
  return obs;
}

export { buildBaselines };
