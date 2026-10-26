// real/soda.ts
// Page through a Socrata (NYC Open Data) dataset with $limit / $offset.
// Rows are ordered by the date field PLUS the id field, so two pages never overlap or skip
// a row even when many rows share one timestamp. Every page goes through real/net.ts
// (cache, retry, timeout), so a second run is offline.

import { cachedGet, readEnv, soqlUrl, socrataHeaders } from "./net";

const HEADERS = socrataHeaders(readEnv());
export const PAGE = 50_000;

export interface SodaQuery {
  select: string;
  where: string;
  order: string; // "date_field, id_field"
  group?: string; // optional $group: the portal aggregates server-side (Phase 9 DOT hourly means)
}

export async function fetchRows(prefix: string, dataset: string, q: SodaQuery): Promise<{ rows: Record<string, string>[]; queryText: string }> {
  const rows: Record<string, string>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const params: Record<string, string> = { $select: q.select, $where: q.where, $order: q.order, $limit: String(PAGE), $offset: String(offset) };
    if (q.group) params.$group = q.group;
    const url = soqlUrl(dataset, params);
    const r = await cachedGet(`${prefix}-o${offset}`, url, { headers: HEADERS, timeoutMs: 180_000 });
    if (r.status !== 200) throw new Error(`${dataset} ${prefix} offset ${offset}: ${r.status === 0 ? r.body : `HTTP ${r.status} ${r.body.slice(0, 200)}`}`);
    const page = JSON.parse(r.body) as Record<string, string>[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { rows, queryText: `${dataset} select=${q.select} where=${q.where} order=${q.order}` };
}

// One-shot aggregate query (group by): small answer, one request.
export async function fetchAggregate(prefix: string, dataset: string, params: Record<string, string>): Promise<Record<string, string>[]> {
  const url = soqlUrl(dataset, { ...params, $limit: "5000" });
  const r = await cachedGet(prefix, url, { headers: HEADERS, timeoutMs: 180_000 });
  if (r.status !== 200) throw new Error(`${dataset} ${prefix}: ${r.status === 0 ? r.body : `HTTP ${r.status} ${r.body.slice(0, 200)}`}`);
  return JSON.parse(r.body) as Record<string, string>[];
}
