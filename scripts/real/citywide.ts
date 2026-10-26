// scripts/real/citywide.ts
// Phase 8 step B. Do EMS calls and hospital arrivals rise during Ida and the 2023 flood at all?
// Phase 7 looked only at the 10 selected zones. Here: CITYWIDE (every EMS incident, any district) and the 10 zones,
// against the dry control days at the same time of day. No engine runs.
//
// Signal: a trailing 30-minute count, every 5 minutes.
//   calls            = incidents (incident_datetime) in the last 30 minutes
//   hospital arrivals = first_hosp_arrival_datetime in the last 30 minutes
// Baseline: the same trailing count on each of the 10 dry days at the same clock time: mean and sd across days.
// z = (event count - baseline mean) / baseline sd.  "Rises" = z >= 3 in at least 2 consecutive bins.
//
// Run: npx tsx scripts/real/citywide.ts       -> docs/real-ems-citywide.html + a printed verdict

import { writeFileSync } from "node:fs";
import { loadContext } from "../../real/context";
import { boardOfEmsCode, zoneIdOfBoard } from "../../real/geo";
import { loadJson } from "../../real/load";
import { localIsoToUtcMs, utcMsToLocalIso } from "../../real/tz";

const ctx = loadContext();
const known = new Set(ctx.zones.map((z) => z.zone_id));
const BIN = 300_000;
const WIN = 6; // bins in 30 minutes

type Scope = "citywide" | "10 zones";
type Signal = "calls" | "hospital arrivals";

// per-bin counts (5 min) of one signal in one scope for a window file, local clock h0..h1 of `day`
function counts(windowId: string, day: string, h0: number, h1: number, signal: Signal, scope: Scope): number[] {
  const from = localIsoToUtcMs(`${day}T${String(h0).padStart(2, "0")}:00:00`) - (WIN - 1) * BIN; // lead-in so the first trailing sum is full
  const to = localIsoToUtcMs(`${day}T${String(h1).padStart(2, "0")}:00:00`);
  const bins = Math.round((to - from) / BIN);
  const out = Array<number>(bins).fill(0);
  for (const r of loadJson("ems", windowId)) {
    const z = zoneIdOfBoard(boardOfEmsCode(r.communitydistrict));
    if (scope === "10 zones" && !(z && known.has(z))) continue;
    const iso = signal === "calls" ? r.incident_datetime : r.first_hosp_arrival_datetime;
    if (!iso) continue;
    const t = localIsoToUtcMs(iso);
    if (t >= from && t < to) out[Math.floor((t - from) / BIN)]++;
  }
  return out;
}

const trailing = (c: number[]) => c.map((_, i) => (i < WIN - 1 ? NaN : c.slice(i - WIN + 1, i + 1).reduce((a, b) => a + b, 0))).slice(WIN - 1);

interface Result {
  title: string;
  signal: Signal;
  scope: Scope;
  event: number[];
  mean: number[];
  sd: number[];
  z: number[];
  h0: number;
  day: string;
}

function analyse(day: string, windowId: string, h0: number, h1: number, signal: Signal, scope: Scope): Result {
  const event = trailing(counts(windowId, day, h0, h1, signal, scope));
  const dry = ctx.controls.dry.map((d) => trailing(counts(`dry-${d}`, d, h0, h1, signal, scope)));
  const mean = event.map((_, i) => dry.reduce((s, x) => s + x[i], 0) / dry.length);
  const sd = event.map((_, i) => Math.sqrt(dry.reduce((s, x) => s + (x[i] - mean[i]) ** 2, 0) / (dry.length - 1)));
  const z = event.map((v, i) => (v - mean[i]) / Math.max(sd[i], 1));
  return { title: `${day} ${signal}, ${scope}`, signal, scope, event, mean, sd, z, h0, day };
}

function verdict(r: Result): string {
  let first: number | undefined;
  for (let i = 0; i + 1 < r.z.length; i++) if (r.z[i] >= 3 && r.z[i + 1] >= 3) { first = i; break; }
  const mi = r.z.indexOf(Math.max(...r.z));
  const at = (i: number) => utcMsToLocalIso(localIsoToUtcMs(`${r.day}T${String(r.h0).padStart(2, "0")}:00:00`) + i * BIN).slice(11, 16);
  const ratio = r.event[mi] / Math.max(r.mean[mi], 0.5);
  return `${r.signal.padEnd(18)} ${r.scope.padEnd(9)} max z ${Math.max(...r.z).toFixed(1).padStart(5)} at ${at(mi)}  (30-min count ${r.event[mi]} vs normal ${r.mean[mi].toFixed(1)}, x${ratio.toFixed(2)})   rises (z>=3 for 2 bins): ${first === undefined ? "NO" : `YES from ${at(first)}`}`;
}

const EVENTS = [
  { name: "Ida 2021-09-01 (NWS emergency 21:28, subways 22:45)", day: "2021-09-01", win: "ida-2021", h0: 16, h1: 24 },
  { name: "Flood 2023-09-29", day: "2023-09-29", win: "flood-2023", h0: 4, h1: 12 },
];
const all: { name: string; res: Result[] }[] = [];
for (const ev of EVENTS) {
  const res: Result[] = [];
  for (const scope of ["citywide", "10 zones"] as Scope[]) for (const signal of ["calls", "hospital arrivals"] as Signal[]) res.push(analyse(ev.day, ev.win, ev.h0, ev.h1, signal, scope));
  all.push({ name: ev.name, res });
  console.log(`\n${ev.name}: trailing 30-minute counts against the 10 dry control days`);
  for (const r of res) console.log("  " + verdict(r));
}

// ---------- HTML ----------
function chart(r: Result): string {
  const W = 360;
  const H = 140;
  const n = r.event.length;
  const top = Math.max(...r.event, ...r.mean.map((m, i) => m + 2 * r.sd[i]), 1) * 1.05;
  const x = (i: number) => 38 + (i / (n - 1)) * (W - 46);
  const y = (v: number) => H - 22 - (v / top) * (H - 36);
  const band = `${r.mean.map((m, i) => `${x(i).toFixed(1)},${y(m + 2 * r.sd[i]).toFixed(1)}`).join(" ")} ${r.mean.map((m, i) => `${x(n - 1 - i).toFixed(1)},${y(Math.max(0, r.mean[n - 1 - i] - 2 * r.sd[n - 1 - i])).toFixed(1)}`).join(" ")}`;
  const line = (v: number[]) => v.map((a, i) => `${x(i).toFixed(1)},${y(a).toFixed(1)}`).join(" ");
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${r.title}"><text x="4" y="12" class="t">${r.title}</text>`;
  s += `<polygon points="${band}" class="band"/><polyline points="${line(r.mean)}" class="base"/><polyline points="${line(r.event)}" class="ev"/>`;
  s += `<text x="4" y="${y(top / 1.05) + 4}" class="d">${Math.round(top)}</text><line x1="38" x2="${W - 8}" y1="${H - 22}" y2="${H - 22}" class="ax"/>`;
  const hours = Math.round(n / 12);
  for (let h = 0; h <= hours; h += 2) s += `<text x="${x(Math.min(h * 12, n - 1)).toFixed(1)}" y="${H - 6}" class="d" text-anchor="middle">${String((r.h0 + h) % 24).padStart(2, "0")}:00</text>`;
  return s + "</svg>";
}
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EMS citywide check</title>
<style>:root{--bg:#fff;--fg:#1f2328;--dim:#656d76;--ax:#d0d7de;--ev:#d1242f;--base:#1f6feb;--band:rgba(31,111,235,.18)}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--dim:#8d96a0;--ax:#30363d;--ev:#ff7b72;--base:#58a6ff;--band:rgba(88,166,255,.2)}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0 auto;max-width:820px;padding:16px}h1{font-size:20px}h2{font-size:16px;margin:22px 0 6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:8px}svg{width:100%;height:auto}.t{font-size:11px;fill:var(--fg)}.d{font-size:10px;fill:var(--dim)}.ax{stroke:var(--ax)}.band{fill:var(--band)}.base{fill:none;stroke:var(--base);stroke-width:1.5}.ev{fill:none;stroke:var(--ev);stroke-width:2}
pre{background:rgba(127,127,127,.12);padding:10px;overflow-x:auto;font-size:11px}</style></head><body>
<h1>Do EMS calls and hospital arrivals rise in a flood?</h1>
<p>Trailing 30-minute counts every 5 minutes. Red: the event day. Blue line and band: mean and plus or minus 2 sd of the 10 dry control days at the same clock time. Citywide = every EMS incident; 10 zones = the Phase 7 zones.</p>
${all.map((a) => `<h2>${a.name}</h2><div class="grid">${a.res.map(chart).join("")}</div><pre>${a.res.map(verdict).join("\n")}</pre>`).join("")}
</body></html>`;
writeFileSync("docs/real-ems-citywide.html", html);
console.log("\nwrote docs/real-ems-citywide.html");
