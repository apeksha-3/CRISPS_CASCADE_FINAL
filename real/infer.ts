// real/infer.ts
// Pure helpers for discovery: work out which columns hold timestamps when the
// portal does not send type headers, and which column is the main event time.

// "2021-09-01", "2021-09-01T21:30:00", "2021-09-01T21:30:00.000", "2021-09-01 21:30", optional Z or +hh:mm.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function looksLikeIsoDate(v: unknown): boolean {
  return typeof v === "string" && ISO_DATE.test(v.trim());
}

// A column is a timestamp if every non-empty sample value is an ISO date
// (and at least one value is present).
export function inferTimestampColumns(rows: Record<string, unknown>[]): string[] {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
  return keys.filter((k) => {
    const vals = rows.map((r) => r[k]).filter((v) => v !== undefined && v !== null && v !== "");
    return vals.length > 0 && vals.every(looksLikeIsoDate);
  });
}

// Words that suggest the main event time, best first. Used only to RANK the
// timestamp columns the portal actually reports.
const DATE_HINTS = [/^created_date$/, /incident_datetime/, /^crash_date$/, /data_as_of/, /date/, /time/];

export function pickDateField(timestampColumns: string[]): string | undefined {
  for (const hint of DATE_HINTS) {
    const hit = timestampColumns.find((c) => hint.test(c));
    if (hit) return hit;
  }
  return timestampColumns[0];
}
