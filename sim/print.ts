// sim/print.ts
// Human-readable views of episodes: a minute-by-minute timeline and a stats table.

import type { Event, EventKind } from "../engine/types";
import { groupOf } from "./dataset";
import { countSignalEvents } from "./episode";
import type { Episode } from "./truth";

const COLS: [EventKind, string][] = [
  ["rain_heavy", "rain"],
  ["drainage_anomaly", "drain"],
  ["traffic_slowdown", "traff"],
  ["emergency_call_spike", "calls"],
  ["hospital_arrivals_unusual", "hosp"],
  ["power_comms_load", "power"],
  ["citizen_report", "citiz"],
  ["gateway_heartbeat_lost", "gwlost"],
  ["retraction", "retr"],
  ["heartbeat", "hb"],
];

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const pad = (x: string | number, n: number) => String(x).padStart(n);

// Row "m" holds events with arrived_at in ((m-1)*60, m*60]: exactly what the
// engine's tick at minute m sees for the first time.
export function rowOf(e: Event): number {
  return Math.max(1, Math.ceil(e.arrived_at / 60));
}

export function header(ep: Episode): string[] {
  const t = ep.truth;
  const lines = [
    `Episode ${ep.episode_id}  type=${ep.type}${t.lookalike ? ` lookalike=${t.lookalike}` : ""}${t.variant ? ` variant=${t.variant}` : ""}${t.base_type ? ` base=${t.base_type}` : ""}`,
    `  truth=${t.hypothesis}  duration=${ep.duration / 60} min  events=${ep.events.length} total, ${countSignalEvents(ep.events)} non-heartbeat  sources=${ep.registry.sources.length}  build_attempt=${t.build_attempt}`,
  ];
  if (t.onset !== undefined) lines.push(`  onset ${mmss(t.onset)}`);
  const st = Object.entries(t.stage_times).sort((a, b) => a[1]! - b[1]!);
  if (st.length) lines.push(`  stage first starts: ${st.map(([k, v]) => `${k} ${mmss(v!)}`).join(", ")}`);
  if (t.critical_time !== undefined) lines.push(`  critical time ${mmss(t.critical_time)}`);
  if (t.split_time !== undefined) lines.push(`  twin ${t.twin_pair_id} role=${t.twin_role} split ${mmss(t.split_time)}`);
  for (const g of t.failed_gateways) lines.push(`  gateway ${g.gateway_id} ${g.mode} ${mmss(g.from)}-${mmss(g.to)}${g.backlog ? " (backlog dump at return)" : ""}`);
  for (const c of t.cutouts) lines.push(`  cutout ${c.source_type ?? c.gateway_id} ${mmss(c.from)}-${mmss(c.to)}`);
  if (t.rumor) lines.push(`  rumor ${t.rumor.narrative_id} in ${t.rumor.zone_id}, ${t.rumor.reports} reports ${mmss(t.rumor.from)}-${mmss(t.rumor.to)}, real event: ${t.rumor.with_real_event}`);
  if (t.duplicate_storm) lines.push(`  duplicate storm ${t.duplicate_storm.reports} reports of one incident in ${t.duplicate_storm.zone_id}`);
  if (t.drifting_sources.length) lines.push(`  drifting sources: ${t.drifting_sources.map((d) => d.source_id).join(", ")}`);
  return lines;
}

export function timeline(ep: Episode, opts: { splitAt?: number } = {}): string {
  const lines = header(ep);
  const rows = ep.duration / 60;
  const counts: Record<number, Record<string, number>> = {};
  for (const e of ep.events) {
    const r = rowOf(e);
    counts[r] ??= {};
    counts[r][e.kind] = (counts[r][e.kind] ?? 0) + 1;
  }
  // stage starts by the minute they begin, for the notes column
  const notes: Record<number, string[]> = {};
  for (const s of ep.truth.stages) {
    const r = Math.max(1, Math.ceil(s.start / 60));
    (notes[r] ??= []).push(`${s.kind.split("_")[0]}@${s.zone_id}`);
  }
  if (ep.truth.critical_time !== undefined) (notes[Math.ceil(ep.truth.critical_time / 60)] ??= []).push("CRITICAL");
  lines.push("");
  lines.push(` min | ${COLS.map(([, c]) => pad(c, 5)).join(" ")} | total(no hb) | true stage starts`);
  const cum = { all: 0 };
  for (let m = 1; m <= rows; m++) {
    const c = counts[m] ?? {};
    const sig = Object.entries(c).filter(([k]) => k !== "heartbeat").reduce((s, [, v]) => s + v, 0);
    cum.all += sig;
    lines.push(` ${pad(m, 3)} | ${COLS.map(([k]) => pad(c[k] ?? 0, 5)).join(" ")} | ${pad(sig, 5)} ${pad(`(${cum.all})`, 6)} | ${(notes[m] ?? []).join(" ")}`);
    if (opts.splitAt !== undefined && m * 60 === opts.splitAt) {
      lines.push(` ---- twin split at ${mmss(opts.splitAt)}: prefix ends here (${cum.all} non-heartbeat events arrived so far) ----`);
    }
  }
  return lines.join("\n");
}

export function statsTable(splits: [string, Episode[]][]): string {
  const lines: string[] = [];
  let outside = 0;
  for (const [name, eps] of splits) {
    const groups = new Map<string, Episode[]>();
    for (const ep of eps) {
      const g = groupOf(ep);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(ep);
    }
    lines.push(`\n== ${name}: ${eps.length} episodes ==`);
    lines.push(`${"group".padEnd(26)} ${pad("n", 4)} ${pad("mean", 6)} ${pad("min", 5)} ${pad("max", 5)} ${pad("w/ hb", 7)} ${pad("dur(min)", 9)} ${pad("outside", 8)}`);
    const all: number[] = [];
    for (const g of [...groups.keys()].sort()) {
      const list = groups.get(g)!;
      const n = list.map((e) => countSignalEvents(e.events));
      const bad = n.filter((x) => x < 100 || x > 700).length;
      outside += bad;
      all.push(...n);
      const meanTotal = list.reduce((s, e) => s + e.events.length, 0) / list.length;
      const dur = list.reduce((s, e) => s + e.duration, 0) / list.length / 60;
      lines.push(`${g.padEnd(26)} ${pad(list.length, 4)} ${pad(mean(n).toFixed(0), 6)} ${pad(Math.min(...n), 5)} ${pad(Math.max(...n), 5)} ${pad(meanTotal.toFixed(0), 7)} ${pad(dur.toFixed(1), 9)} ${pad(bad, 8)}`);
    }
    lines.push(`${"ALL".padEnd(26)} ${pad(all.length, 4)} ${pad(mean(all).toFixed(0), 6)} ${pad(Math.min(...all), 5)} ${pad(Math.max(...all), 5)}`);
  }
  lines.push(`\nEvent counts are non-heartbeat events (healthy range 100-700). "w/ hb" includes heartbeats.`);
  lines.push(`Episodes outside 100-700: ${outside}`);
  return lines.join("\n");
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
