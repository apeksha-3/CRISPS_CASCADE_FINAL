// eval/report.ts
// Aggregate per-episode results into the summary table.

import { mean } from "./metrics";
import { COMMIT_P, type EpisodeResult } from "./run";

export interface Summary {
  episodes: number;
  ticks: number;
  brier: number;
  log_loss: number;
  cost_per_tick: number; // mean of per-episode cost/tick (length-normalized)
  cost_total: number; // raw sum over all ticks of all episodes
  cascades: number;
  cascades_alerted: number;
  mean_lead_min: number;
  benign: number;
  false_alarms: number;
  false_alarm_rate: number;
  flips_total: number;
  flips_per_episode: number;
  twin_pre_split_overconf: number;
  twin_commit_cascade_min: number;
  twin_commit_cascade_never: number;
  twin_commit_benign_min: number;
  twin_commit_benign_never: number;
  fallback_ticks: number;
  degraded_ticks: number;
  degraded_episodes: number;
  forecast_items: number; // cascade episodes only
  forecast_accuracy: number; // share of forecast lines with a real event of that kind inside their window
  forecast_start_accuracy: number; // stricter: share whose stage truly STARTED inside the window
}

// "Benign" = nothing real is happening: NOISE or SENSOR_FAILURE truth.
const isBenign = (r: EpisodeResult) => r.hypothesis === "NOISE" || r.hypothesis === "SENSOR_FAILURE";

export function summarize(rs: EpisodeResult[]): Summary {
  const cas = rs.filter((r) => r.hypothesis === "CASCADING_CRISIS");
  const ben = rs.filter(isBenign);
  const twins = rs.filter((r) => r.twin_role !== undefined);
  const commits = (role: string) => twins.filter((r) => r.twin_role === role);
  const done = (xs: EpisodeResult[]) => xs.filter((r) => r.commit_min !== null && r.commit_min !== undefined).map((r) => r.commit_min!);
  const fa = ben.filter((r) => r.any_alert).length;
  return {
    episodes: rs.length,
    ticks: rs.reduce((s, r) => s + r.ticks, 0),
    brier: mean(rs.map((r) => r.brier)),
    log_loss: mean(rs.map((r) => r.log_loss)),
    cost_per_tick: mean(rs.map((r) => r.cost_per_tick)),
    cost_total: rs.reduce((s, r) => s + r.cost_total, 0),
    cascades: cas.length,
    cascades_alerted: cas.filter((r) => r.lead_min !== undefined).length,
    mean_lead_min: mean(cas.filter((r) => r.lead_min !== undefined).map((r) => r.lead_min!)),
    benign: ben.length,
    false_alarms: fa,
    false_alarm_rate: ben.length ? fa / ben.length : NaN,
    flips_total: rs.reduce((s, r) => s + r.flips, 0),
    flips_per_episode: mean(rs.map((r) => r.flips)),
    twin_pre_split_overconf: mean(twins.map((r) => r.pre_split_overconf!)),
    twin_commit_cascade_min: mean(done(commits("cascade"))),
    twin_commit_cascade_never: commits("cascade").length - done(commits("cascade")).length,
    twin_commit_benign_min: mean(done(commits("benign"))),
    twin_commit_benign_never: commits("benign").length - done(commits("benign")).length,
    fallback_ticks: rs.reduce((s, r) => s + r.fallback_ticks, 0),
    degraded_ticks: rs.reduce((s, r) => s + (r.degraded_ticks ?? 0), 0),
    degraded_episodes: rs.filter((r) => (r.degraded_ticks ?? 0) > 0).length,
    forecast_items: rs.reduce((s, r) => s + (r.forecast_items ?? 0), 0),
    forecast_accuracy: rs.reduce((s, r) => s + (r.forecast_hits ?? 0), 0) / rs.reduce((s, r) => s + (r.forecast_items ?? 0), 0),
    forecast_start_accuracy: rs.reduce((s, r) => s + (r.forecast_start_hits ?? 0), 0) / rs.reduce((s, r) => s + (r.forecast_items ?? 0), 0),
  };
}

export function groupBy(rs: EpisodeResult[]): [string, EpisodeResult[]][] {
  const m = new Map<string, EpisodeResult[]>();
  for (const r of rs) {
    if (!m.has(r.group)) m.set(r.group, []);
    m.get(r.group)!.push(r);
  }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "-");
const pad = (x: string | number, n: number) => String(x).padStart(n);

export function formatReport(policy: string, split: string, s: Summary, groups: [string, EpisodeResult[]][]): string {
  const L: string[] = [];
  L.push(`Policy: ${policy}   split: ${split}   episodes: ${s.episodes}   ticks: ${s.ticks}`);
  L.push("");
  L.push(`  Brier score (mean per episode, 0 best, 2 worst)  ${f(s.brier)}`);
  L.push(`  Log-loss (mean per episode)                      ${f(s.log_loss)}`);
  L.push(`  Cost per tick (mean of per-episode cost/ticks)   ${f(s.cost_per_tick, 2)}`);
  L.push(`  Total cost (raw sum over all ticks)              ${f(s.cost_total, 0)}`);
  L.push(`  Mean lead time vs critical time (min)            ${f(s.mean_lead_min, 2)}   (${s.cascades_alerted}/${s.cascades} cascades reached ALERT+)`);
  L.push(`  False-alarm rate (benign episodes with ALERT+)   ${pct(s.false_alarm_rate)}   (${s.false_alarms}/${s.benign})`);
  L.push(`  Flip-flops                                       ${s.flips_total} total, ${f(s.flips_per_episode, 2)} per episode`);
  L.push(`  Twin: pre-split overconfidence (0 = base rates)  ${f(s.twin_pre_split_overconf)}`);
  L.push(`  Twin: time-to-commit after split (p>=${COMMIT_P}, min)  cascade ${f(s.twin_commit_cascade_min, 2)} (never: ${s.twin_commit_cascade_never}), benign ${f(s.twin_commit_benign_min, 2)} (never: ${s.twin_commit_benign_never})`);
  L.push(`  Fallback ticks                                   ${s.fallback_ticks}`);
  L.push(`  DEGRADED ticks                                   ${s.degraded_ticks}   (${s.degraded_episodes} episodes)`);
  L.push(`  Forecast accuracy (cascades: real event in window) ${pct(s.forecast_accuracy)}   (${s.forecast_items} distinct forecast lines; stricter "stage started in window": ${pct(s.forecast_start_accuracy)})`);
  L.push("");
  L.push(`${"group".padEnd(26)} ${pad("n", 3)} ${pad("truth", 9)} ${pad("Brier", 6)} ${pad("LogLoss", 7)} ${pad("Cost/tick", 9)} ${pad("ALERT+", 7)} ${pad("Lead(min)", 9)} ${pad("Flips", 5)}`);
  for (const [g, rs] of groups) {
    const s2 = summarize(rs);
    const truth = [...new Set(rs.map((r) => short(r.hypothesis)))].join("/");
    const alertRate = rs.filter((r) => r.any_alert).length / rs.length;
    L.push(`${g.padEnd(26)} ${pad(rs.length, 3)} ${pad(truth, 9)} ${pad(f(s2.brier), 6)} ${pad(f(s2.log_loss), 7)} ${pad(f(s2.cost_per_tick, 2), 9)} ${pad(pct(alertRate), 7)} ${pad(f(s2.mean_lead_min, 2), 9)} ${pad(s2.flips_total, 5)}`);
  }
  L.push("");
  L.push(`ALERT+ = share of episodes where the policy ever reached ALERT or ESCALATE (a false alarm when truth is NOISE/SENS).`);
  return L.join("\n");
}

const short = (h: string) => ({ NOISE: "NOISE", SENSOR_FAILURE: "SENS", ISOLATED_INCIDENT: "ISO", CASCADING_CRISIS: "CASC" })[h] ?? h;

// One row per policy, then the engine-vs-count-threshold deltas (negative = engine lower = better).
export function formatComparison(split: string, rows: [string, Summary][]): string {
  const L: string[] = [];
  L.push(`Policy comparison, split ${split}`);
  L.push(`${"policy".padEnd(16)} ${pad("Brier", 6)} ${pad("LogLoss", 7)} ${pad("Cost/tick", 9)} ${pad("FalseAlarm", 10)} ${pad("Lead(min)", 9)} ${pad("Flips", 5)} ${pad("Fallback", 8)} ${pad("Forecast", 8)}`);
  for (const [n, s] of rows) {
    L.push(`${n.padEnd(16)} ${pad(f(s.brier), 6)} ${pad(f(s.log_loss), 7)} ${pad(f(s.cost_per_tick, 2), 9)} ${pad(pct(s.false_alarm_rate), 10)} ${pad(f(s.mean_lead_min, 2), 9)} ${pad(s.flips_total, 5)} ${pad(s.fallback_ticks, 8)} ${pad(pct(s.forecast_accuracy), 8)}`);
  }
  const get = (name: string) => rows.find(([n]) => n === name)?.[1];
  const c = get("count-threshold");
  const vs = (a: string, b: string) => {
    const e = get(a);
    const o = get(b);
    if (!e || !o) return;
    const d = (x: number, unit = "", digits = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(digits)}${unit} (${x < 0 ? `${a} better` : x > 0 ? `${a} worse` : "tie"})`;
    const wins = [e.brier < o.brier, e.false_alarm_rate < o.false_alarm_rate, e.cost_per_tick < o.cost_per_tick].filter(Boolean).length;
    L.push(`${a} vs ${b}: Brier ${d(e.brier - o.brier)}, false-alarm rate ${d(100 * (e.false_alarm_rate - o.false_alarm_rate), " pts", 1)}, cost/tick ${d(e.cost_per_tick - o.cost_per_tick, "", 2)}  -> ${a} wins ${wins}/3`);
  };
  L.push("");
  if (c) {
    vs("engine", "count-threshold");
    vs("engine-handset", "count-threshold");
  }
  vs("engine", "engine-handset");
  return L.join("\n");
}

// Learning panels (Phase 4) ------------------------------------------------------

export function formatPrior(p: Record<string, number>): string {
  return `N ${p.NOISE.toFixed(3)}  S ${p.SENSOR_FAILURE.toFixed(3)}  I ${p.ISOLATED_INCIDENT.toFixed(3)}  C ${p.CASCADING_CRISIS.toFixed(3)}`;
}

// Top and bottom sources by learned trust.
export function formatTrustPanel(ranked: { source_id: string; source_type: string; alpha: number; beta: number; mean: number }[], n = 5): string {
  const line = (t: (typeof ranked)[number]) => `  ${t.source_id.padEnd(14)} ${t.source_type.padEnd(16)} trust ${t.mean.toFixed(3)}   Beta(${t.alpha.toFixed(1)}, ${t.beta.toFixed(1)})`;
  const L = [`Trust panel (${ranked.length} sources ever seen)`, `top ${n}:`, ...ranked.slice(0, n).map(line), `bottom ${n}:`, ...ranked.slice(-n).map(line)];
  const byType = new Map<string, number[]>();
  for (const t of ranked) byType.set(t.source_type, [...(byType.get(t.source_type) ?? []), t.mean]);
  L.push("mean trust by source type:");
  for (const [type, xs] of [...byType.entries()].sort((a, b) => mean(b[1]) - mean(a[1]))) L.push(`  ${type.padEnd(16)} ${mean(xs).toFixed(3)}   (${xs.length} sources, min ${Math.min(...xs).toFixed(3)}, max ${Math.max(...xs).toFixed(3)})`);
  return L.join("\n");
}

// Prior-shift sequence: the halves before / after the regime change.
export function formatShift(rows: [string, EpisodeResult[]][], shiftAt: number): string {
  const L = [`Prior-shift sequence: episodes 1-${shiftAt} normal regime, ${shiftAt + 1}-${rows[0][1].length} monsoon`];
  L.push(`${"policy".padEnd(20)} ${pad("Brier 1-50", 10)} ${pad("Brier 51-100", 12)} ${pad("Cost 1-50", 9)} ${pad("Cost 51-100", 11)} ${pad("FA 1-50", 8)} ${pad("FA 51-100", 9)}`);
  for (const [name, rs] of rows) {
    const a = summarize(rs.slice(0, shiftAt));
    const b = summarize(rs.slice(shiftAt));
    L.push(`${name.padEnd(20)} ${pad(f(a.brier), 10)} ${pad(f(b.brier), 12)} ${pad(f(a.cost_per_tick, 2), 9)} ${pad(f(b.cost_per_tick, 2), 11)} ${pad(pct(a.false_alarm_rate), 8)} ${pad(pct(b.false_alarm_rate), 9)}`);
  }
  return L.join("\n");
}
