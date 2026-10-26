// real/tz.ts
// NYC local time <-> UTC, using the real timezone rules (America/New_York).
// In summer NYC is on EDT (UTC-4), in winter on EST (UTC-5). The change days
// are handled by the platform's timezone database, not by a hand-made offset.
//
// Socrata "floating timestamps" are local wall-clock times with no zone, so
// they go through localIsoToUtcMs. IEM (valid(UTC)) and NOAA ISD (DATE) are UTC,
// so they go through utcMsToLocalIso when we want to show or compare local time.

const TZ = "America/New_York";
const FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// The local wall-clock fields of a UTC instant.
function localParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const part of FMT.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

// UTC instant (ms) -> "YYYY-MM-DDTHH:MM:SS" in NYC local time.
export function utcMsToLocalIso(ms: number): string {
  const p = localParts(ms);
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

// How far local time is ahead of UTC at this instant, in ms (EDT: -4h, EST: -5h).
function offsetMs(ms: number): number {
  const p = localParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// "2021-09-01T21:28:00" (NYC wall clock; a trailing .000 is fine) -> UTC instant in ms.
// We guess the instant, measure the offset there, and correct once more
// (needed only right around the clock-change hour).
export function localIsoToUtcMs(iso: string): number {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/);
  if (!m) throw new Error(`not a local ISO time: ${iso}`);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  let guess = wall - offsetMs(wall);
  guess = wall - offsetMs(guess);
  return guess;
}

// IEM "valid(UTC)" like "2021-09-02 01:50" or NOAA ISD DATE like "2021-09-02T01:50:00" -> UTC instant in ms.
export function utcStringToMs(s: string): number {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?Z?$/);
  if (!m) throw new Error(`not a UTC time: ${s}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

// UTC instant -> "YYYY-MM-DDTHH:MM" in UTC, the form IEM wants in sts / ets.
export function utcMsToIemZ(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16) + "Z";
}

// Add whole days to a "YYYY-MM-DD" date (calendar arithmetic, no time zone involved).
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
}
