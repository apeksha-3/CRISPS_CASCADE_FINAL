// real/nws.ts
// Read NWS Flash Flood Warning products (pil FFWOKX, the New York office) from the Iowa Environmental
// Mesonet text archive, and group the ones that cover New York City counties into EVENTS.
// Pure parsing: no network here (scripts/real/events-find.ts fetches).

import { localIsoToUtcMs } from "./tz";

export interface Ffw {
  issued_utc: number; // ms
  issued_local: string; // "2021-09-01T21:28:00"
  action: string; // NEW, CON, EXT, EXA, EXB, CAN, EXP, COR
  etn: string; // the warning's number in the year
  nyc_counties: string[]; // Bronx, Kings, New York, Queens, Richmond (those named in the product)
  emergency: boolean; // the product is a Flash Flood EMERGENCY
  emergency_nyc: boolean; // ... and its headline names New York City or one of its boroughs
}

const MONTHS: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

export function parseFfwBundle(text: string): Ffw[] {
  const out: Ffw[] = [];
  for (const p of text.split("\x01")) {
    if (!p.includes("KOKX")) continue;
    const t = p.match(/\n\s*(\d{1,2})(\d{2}) (AM|PM) (EDT|EST) \w{3} (\w{3}) (\d{1,2}) (\d{4})/);
    const v = p.match(/\/O\.(\w{3})\.KOKX\.FF\.W\.(\d{4})\./);
    if (!t || !v) continue;
    let h = Number(t[1]) % 12;
    if (t[3] === "PM") h += 12;
    const local = `${t[7]}-${pad(MONTHS[t[5]])}-${pad(Number(t[6]))}T${pad(h)}:${t[2]}:00`;
    const counties: string[] = [];
    for (const [name, re] of [["Bronx", /Bronx County/], ["Kings", /Kings( \(Brooklyn\))? County/], ["New York", /New York( \(Manhattan\))? County in/], ["Queens", /Queens County/], ["Richmond", /Richmond( \(Staten Island\))? County/]] as [string, RegExp][]) if (re.test(p)) counties.push(name);
    const head = p.match(/\.\.\.FLASH FLOOD EMERGENCY FOR([^\n]*(?:\n[^\n.]*)?)/i);
    out.push({
      issued_utc: localIsoToUtcMs(local),
      issued_local: local,
      action: v[1],
      etn: v[2],
      nyc_counties: counties,
      emergency: /FLASH FLOOD EMERGENCY/.test(p),
      emergency_nyc: !!head && /NEW YORK CITY|NYC|BROOKLYN|QUEENS|BRONX|MANHATTAN|STATEN/i.test(head[1]),
    });
  }
  return out.sort((a, b) => a.issued_utc - b.issued_utc);
}

export interface FloodEvent {
  id: string; // "ffw-2021-09-01": the local date of the first NYC warning
  first_local: string;
  last_local: string;
  products: number; // warning products naming a NYC county
  new_products: number;
  emergency_nyc: boolean;
  boroughs: string[];
}

// Products that name a NYC county, grouped: a new event starts when 8 hours pass with no such product.
export function groupEvents(all: Ffw[], gapHours = 8): FloodEvent[] {
  const nyc = all.filter((f) => f.nyc_counties.length > 0 && !["CAN", "EXP"].includes(f.action));
  const events: Ffw[][] = [];
  for (const f of nyc) {
    const last = events[events.length - 1];
    if (last && f.issued_utc - last[last.length - 1].issued_utc <= gapHours * 3_600_000) last.push(f);
    else events.push([f]);
  }
  return events.map((g) => ({
    id: `ffw-${g[0].issued_local.slice(0, 10)}`,
    first_local: g[0].issued_local,
    last_local: g[g.length - 1].issued_local,
    products: g.length,
    new_products: g.filter((f) => f.action === "NEW").length,
    emergency_nyc: g.some((f) => f.emergency_nyc),
    boroughs: [...new Set(g.flatMap((f) => f.nyc_counties))].sort(),
  }));
}
