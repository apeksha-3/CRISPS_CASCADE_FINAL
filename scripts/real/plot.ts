// scripts/real/plot.ts
// Phase 7 step E: the Ida timeline. One self-contained HTML file (inline SVG, no libraries).
// For Ida and two controls (the heaviest rain-control day and one dry day in the same month),
// per 5 minutes between 16:00 and 24:00 local:
//   rain mm/h (max of 3 stations) | 311 flood+drainage reports | traffic slowdowns | EMS calls | hospital arrivals
// 311, traffic and slowdowns are counted in the 10 selected zones, after the adapters. EMS calls and
// hospital arrivals are RAW counts of EMS incidents / hospital arrivals in those zones (not the spike events).
//
// It also prints the chain verdict: when does each series first turn "elevated" on Ida, where
// elevated = above the highest value of that series in the same hours on ANY control day
// (10 dry + 8 rain) for 2 of 3 consecutive 5-minute bins. For rain: 7.6 mm/h or more.
//
// Run: npx tsx scripts/real/plot.ts

import { writeFileSync } from "node:fs";
import { rainBuckets } from "../../real/adapt-rain";
import { buildBaselines } from "../../real/baselines";
import { loadContext, observe, type Context } from "../../real/context";
import { boardOfEmsCode, zoneIdOfBoard } from "../../real/geo";
import { loadIem, loadJson } from "../../real/load";
import { Unmapped } from "../../real/obs";
import { RAIN_HEAVY_MM_H } from "../../real/params";
import { addDays, localIsoToUtcMs, utcMsToLocalIso } from "../../real/tz";

const ctx = loadContext();
const BIN = 300_000;
const NAMES = ["rain mm/h (max of 3 stations)", "311 flood + drainage reports", "traffic slowdowns (events)", "EMS calls (raw incidents)", "hospital arrivals (raw)"] as const;

interface Panel {
  title: string;
  day: string;
  windowId: string;
  series: number[][]; // NAMES.length x bins
}

function series(c: Context, windowId: string, day: string, h0: number, h1: number, leaveOut?: string): number[][] {
  const from = localIsoToUtcMs(`${day}T${String(h0).padStart(2, "0")}:00:00`);
  const to = localIsoToUtcMs(`${day}T${String(h1).padStart(2, "0")}:00:00`);
  const bins = Math.round((to - from) / BIN);
  const out = NAMES.map(() => Array<number>(bins).fill(0));
  const bin = (t: number) => Math.floor((t - from) / BIN);
  const base = buildBaselines(c.controls.dry, c.zones, leaveOut);
  const obs = observe(c, windowId, from, to, base, new Unmapped());
  for (const o of obs) {
    const b = bin(o.t_ms);
    if (b < 0 || b >= bins) continue;
    if (o.kind === "citizen_report" || o.kind === "drainage_anomaly") out[1][b]++;
    if (o.kind === "traffic_slowdown" && o.source_id.startsWith("trf-")) out[2][b]++;
  }
  for (const st of ["NYC", "JFK", "LGA"])
    for (const r of rainBuckets(loadIem(windowId), st, from, to)) {
      const b = bin(r.t_ms - 1);
      if (b >= 0 && b < bins && r.minutes >= 3) out[0][b] = Math.max(out[0][b], r.mmh);
    }
  const known = new Set(c.zones.map((z) => z.zone_id));
  for (const r of loadJson("ems", windowId)) {
    const z = zoneIdOfBoard(boardOfEmsCode(r.communitydistrict));
    if (!z || !known.has(z)) continue;
    const t = localIsoToUtcMs(r.incident_datetime);
    if (t >= from && t < to) out[3][bin(t)]++;
    if (r.first_hosp_arrival_datetime) {
      const h = localIsoToUtcMs(r.first_hosp_arrival_datetime);
      if (h >= from && h < to) out[4][bin(h)]++;
    }
  }
  return out;
}

// first bin where `elevated` holds in 2 of 3 consecutive bins starting there
function firstElevated(vals: number[], threshold: number): number | undefined {
  for (let i = 0; i < vals.length; i++) {
    const w = vals.slice(i, i + 3);
    if (vals[i] > threshold && w.filter((v) => v > threshold).length >= 2) return i;
  }
  return undefined;
}

function chain(name: string, day: string, windowId: string, h0: number, h1: number) {
  const target = series(ctx, windowId, day, h0, h1);
  const controls: number[][][] = [];
  for (const d of ctx.controls.dry) controls.push(series(ctx, `dry-${d}`, d, h0, h1, d));
  for (const d of ctx.controls.rain) controls.push(series(ctx, `rain-${d}`, d, h0, h1));
  const lines: string[] = [];
  const first: (number | undefined)[] = [];
  for (let s = 0; s < NAMES.length; s++) {
    const thr = s === 0 ? RAIN_HEAVY_MM_H : Math.max(...controls.flatMap((c) => c[s]));
    const i = firstElevated(target[s], thr);
    first.push(i);
    const from = localIsoToUtcMs(`${day}T${String(h0).padStart(2, "0")}:00:00`);
    // second, softer rule: above this day's own early-evening level (mean + 3 sd of the first 4 hours) for 2 of 3 bins
    const pre = target[s].slice(0, Math.min(48, target[s].length));
    const mu = pre.reduce((a, b) => a + b, 0) / pre.length;
    const sd = Math.sqrt(pre.reduce((a, b) => a + (b - mu) ** 2, 0) / pre.length);
    const j = s === 0 ? i : firstElevated(target[s].slice(48), mu + 3 * sd);
    const fromMs = localIsoToUtcMs(`${day}T${String(h0).padStart(2, "0")}:00:00`);
    const own = j === undefined ? "never" : utcMsToLocalIso(fromMs + (j + (s === 0 ? 0 : 48)) * BIN).slice(11, 16);
    lines.push(`  ${NAMES[s].padEnd(32)} threshold ${thr.toFixed(1).padStart(6)}   first above control max ${i === undefined ? "never" : utcMsToLocalIso(from + i * BIN).slice(11, 16)}   first above own first-4h level ${own}   peak ${Math.max(...target[s]).toFixed(1)} at ${utcMsToLocalIso(localIsoToUtcMs(`${day}T${String(h0).padStart(2, "0")}:00:00`) + target[s].indexOf(Math.max(...target[s])) * BIN).slice(11, 16)}`);
  }
  return { name, target, lines, first, from: localIsoToUtcMs(`${day}T${String(h0).padStart(2, "0")}:00:00`) };
}

// ---------- HTML ----------
const COLORS = ["#1f6feb", "#d1242f", "#bf8700", "#8250df", "#1a7f37"];
function panelSvg(p: Panel, marks: { t: number; label: string }[], from: number): string {
  const W = 760;
  const rowH = 70;
  const H = rowH * NAMES.length + 30;
  const bins = p.series[0].length;
  const x = (i: number) => 150 + (i / bins) * (W - 160);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${p.title}">`;
  p.series.forEach((vals, k) => {
    const y0 = 10 + k * rowH;
    const max = Math.max(1, ...vals);
    s += `<text x="4" y="${y0 + 22}" class="lab">${NAMES[k]}</text><text x="4" y="${y0 + 38}" class="lab dim">max ${max.toFixed(max < 10 ? 1 : 0)}</text>`;
    s += `<line x1="150" x2="${W - 10}" y1="${y0 + rowH - 14}" y2="${y0 + rowH - 14}" class="axis"/>`;
    vals.forEach((v, i) => {
      const h = (v / max) * (rowH - 24);
      s += `<rect x="${x(i).toFixed(1)}" y="${(y0 + rowH - 14 - h).toFixed(1)}" width="${((W - 160) / bins - 0.6).toFixed(1)}" height="${h.toFixed(1)}" fill="${COLORS[k]}"/>`;
    });
  });
  for (let h = 0; h <= bins / 12; h += 2) s += `<text x="${x(h * 12)}" y="${H - 4}" class="lab dim" text-anchor="middle">${String(16 + h).padStart(2, "0")}:00</text>`;
  for (const [mi, m] of marks.entries()) {
    const i = (m.t - from) / BIN;
    if (i < 0 || i > bins) continue;
    s += `<line x1="${x(i)}" x2="${x(i)}" y1="8" y2="${H - 18}" class="mark"/><text x="${x(i) + (mi === 0 ? -3 : 3)}" y="16" class="lab mk" text-anchor="${mi === 0 ? "end" : "start"}">${m.label}</text>`;
  }
  return s + "</svg>";
}

const ida = chain("Ida 2021-09-01", "2021-09-01", "ida-2021", 16, 24);
const heaviest = ctx.controls.rain[0]; // first of the rain controls; every one is 1.0-2.5 in
const dryDay = ctx.controls.dry.find((d) => d.startsWith("2022-09")) ?? ctx.controls.dry[0];
const rainPanel: Panel = { title: `rain control ${heaviest}`, day: heaviest, windowId: `rain-${heaviest}`, series: series(ctx, `rain-${heaviest}`, heaviest, 16, 24) };
const dryPanel: Panel = { title: `dry control ${dryDay}`, day: dryDay, windowId: `dry-${dryDay}`, series: series(ctx, `dry-${dryDay}`, dryDay, 16, 24, dryDay) };
const idaPanel: Panel = { title: "Ida 2021-09-01", day: "2021-09-01", windowId: "ida-2021", series: ida.target };
const f23 = chain("flood 2023-09-29", "2023-09-29", "flood-2023", 4, 12);

const marks = [
  { t: localIsoToUtcMs("2021-09-01T21:28:00"), label: "NWS flash flood emergency 21:28" },
  { t: localIsoToUtcMs("2021-09-01T22:45:00"), label: "subways suspended 22:45" },
];

const verdictLines = (c: ReturnType<typeof chain>) => c.lines.join("\n");
const order = (c: ReturnType<typeof chain>) =>
  c.first
    .map((i, k) => ({ k, t: i === undefined ? undefined : utcMsToLocalIso(c.from + i * BIN).slice(11, 16) }))
    .filter((x) => x.t !== undefined)
    .sort((a, b) => (a.t! < b.t! ? -1 : 1))
    .map((x) => `${NAMES[x.k].split(" (")[0]} ${x.t}`)
    .join(" -> ");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ida timeline</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--dim:#656d76;--axis:#d0d7de;--mark:#d1242f}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--dim:#8d96a0;--axis:#30363d;--mark:#ff7b72}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0 auto;max-width:820px;padding:16px}
h1{font-size:20px}h2{font-size:16px;margin:24px 0 4px}svg{width:100%;height:auto}.lab{font-size:11px;fill:var(--fg)}.dim{fill:var(--dim)}.axis{stroke:var(--axis)}.mark{stroke:var(--mark);stroke-dasharray:4 3}.mk{fill:var(--mark)}
pre{background:rgba(127,127,127,.12);padding:10px;overflow-x:auto;font-size:12px}
</style></head><body>
<h1>Real NYC data: the Ida timeline</h1>
<p>Five signals per 5 minutes, local time (EDT), 16:00 to 24:00. 311, traffic and slowdowns are counted in the 10 selected zones. EMS calls and hospital arrivals are raw counts in those zones. Bars are scaled to each row's own maximum (shown under the name). Red dashed lines are the cited NWS and MTA times.</p>
<h2>Ida, Wednesday 2021-09-01</h2>${panelSvg(idaPanel, marks, ida.from)}
<h2>Rain control ${heaviest} (heavy rain, no NWS emergency)</h2>${panelSvg(rainPanel, [], ida.from)}
<h2>Dry control ${dryDay}</h2>${panelSvg(dryPanel, [], ida.from)}
<h2>When does each signal first turn elevated on Ida?</h2>
<p>Elevated = above the highest value of that row on any of the 18 control days in the same hours, in 2 of 3 consecutive bins (rain: 7.6 mm/h or more).</p>
<pre>${verdictLines(ida)}

order: ${order(ida)}</pre>
</body></html>`;
writeFileSync("docs/real-ida-timeline.html", html);

console.log(`Ida 2021-09-01, 16:00-24:00 local, first elevated bin per signal`);
console.log(verdictLines(ida));
console.log(`order: ${order(ida)}`);
console.log(`\nflood 2023-09-29, 04:00-12:00 local`);
console.log(verdictLines(f23));
console.log(`order: ${order(f23)}`);
console.log("\nwrote docs/real-ida-timeline.html");
