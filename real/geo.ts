// real/geo.ts
// Zones are NYC community districts. This file holds the pieces that need no network:
// board-name parsing, distances, nearest-centroid assignment, neighbours and gateways.

import { GATEWAY_COUNT, LINK_MAX_KM } from "./params";

export interface RealZone {
  zone_id: string; // "mn12" = Manhattan community district 12
  name: string; // "12 MANHATTAN": the exact community_board text 311 uses
  lat: number; // centroid: mean 311 latitude over the dry control days
  lon: number;
  volume: number; // total 311 requests on the dry control days (the selection score)
  neighbours: string[]; // the 3 nearest other zones by centroid distance, made symmetric
  gateway_id: string; // SYNTHETIC gateway (see docs)
}

const BORO_CODE: Record<string, [string, string]> = {
  MANHATTAN: ["mn", "1"],
  BRONX: ["bx", "2"],
  BROOKLYN: ["bk", "3"],
  QUEENS: ["qn", "4"],
  "STATEN ISLAND": ["si", "5"],
};
const BOARD = /^(\d{2}) (MANHATTAN|BRONX|BROOKLYN|QUEENS|STATEN ISLAND)$/;

// "12 MANHATTAN" -> "mn12". Anything else ("Unspecified", "0 Unspecified", "13 QUEENS" ok) -> undefined.
export function zoneIdOfBoard(board: string | undefined): string | undefined {
  const m = board?.trim().match(BOARD);
  return m ? `${BORO_CODE[m[2]][0]}${m[1]}` : undefined;
}

export function isRealBoard(board: string | undefined): boolean {
  return !!board && BOARD.test(board.trim());
}

// EMS community district code "112" (1 = Manhattan, 12 = district 12) -> "12 MANHATTAN".
export function boardOfEmsCode(code: string | undefined): string | undefined {
  if (!code || !/^\d{3}$/.test(code.trim())) return undefined;
  const boro = Object.entries(BORO_CODE).find(([, v]) => v[1] === code[0])?.[0];
  return boro ? `${code.slice(1)} ${boro}` : undefined;
}

// Straight-line distance in km (equirectangular: fine over a city).
export function distKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const x = (bLon - aLon) * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180)) * 111.32;
  const y = (bLat - aLat) * 110.57;
  return Math.hypot(x, y);
}

// Nearest zone centroid, or undefined when even the nearest is farther than LINK_MAX_KM.
// APPROXIMATION: traffic links and crashes carry no community-board column, so they are placed by distance.
export function nearestZone(zones: Pick<RealZone, "zone_id" | "lat" | "lon">[], lat: number, lon: number, maxKm = LINK_MAX_KM): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const z of zones) {
    const d = distKm(lat, lon, z.lat, z.lon);
    if (d < bestD || (d === bestD && best !== undefined && z.zone_id < best)) {
      bestD = d;
      best = z.zone_id;
    }
  }
  return bestD <= maxKm ? best : undefined;
}

// Each zone's 3 nearest others; then made symmetric (if A lists B, B lists A).
export function buildNeighbours(zones: Pick<RealZone, "zone_id" | "lat" | "lon">[], k = 3): Record<string, string[]> {
  const nb: Record<string, Set<string>> = Object.fromEntries(zones.map((z) => [z.zone_id, new Set<string>()]));
  for (const z of zones) {
    const near = zones
      .filter((o) => o.zone_id !== z.zone_id)
      .map((o) => ({ id: o.zone_id, d: distKm(z.lat, z.lon, o.lat, o.lon) }))
      .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))
      .slice(0, k);
    for (const n of near) {
      nb[z.zone_id].add(n.id);
      nb[n.id].add(z.zone_id);
    }
  }
  return Object.fromEntries(Object.entries(nb).map(([k2, v]) => [k2, [...v].sort()]));
}

// SYNTHETIC gateways by region: zones sorted from north to south are cut into GATEWAY_COUNT
// consecutive groups (sizes differ by at most one). Real NYC feeds have no such gateways.
export function assignGateways(zones: Pick<RealZone, "zone_id" | "lat">[]): Record<string, string> {
  const sorted = zones.slice().sort((a, b) => b.lat - a.lat || (a.zone_id < b.zone_id ? -1 : 1));
  const out: Record<string, string> = {};
  sorted.forEach((z, i) => {
    out[z.zone_id] = `synth-gw${Math.floor((i * GATEWAY_COUNT) / sorted.length)}`;
  });
  return out;
}

// First "lat,lon" pair of a DOT link_points string ("40.60,-74.13 40.60,-74.14 ...").
export function firstPoint(linkPoints: string | undefined): { lat: number; lon: number } | undefined {
  const first = linkPoints?.trim().split(/\s+/)[0];
  if (!first) return undefined;
  const [lat, lon] = first.split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : undefined;
}
