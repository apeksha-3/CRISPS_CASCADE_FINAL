// dashboard/app.js
// Vanilla JS dashboard. The server pushes one TickRecord per simulated minute over
// Server-Sent Events (EventSource); this file only draws what arrives. No framework,
// no chart library: the charts are plain <canvas> drawing.

"use strict";

// ---------- constants ----------
const HYPS = ["NOISE", "SENSOR_FAILURE", "ISOLATED_INCIDENT", "CASCADING_CRISIS"];
const HYP_LABEL = { NOISE: "NOISE", SENSOR_FAILURE: "SENSOR_FAILURE", ISOLATED_INCIDENT: "ISOLATED", CASCADING_CRISIS: "CASCADE" };
const HYP_VAR = { NOISE: "--noise", SENSOR_FAILURE: "--sensor", ISOLATED_INCIDENT: "--isolated", CASCADING_CRISIS: "--cascade" };
const ACTIONS = ["WATCH", "PREPARE", "ALERT", "ESCALATE"];
const ACTION_VAR = { WATCH: "--watch", PREPARE: "--prepare", ALERT: "--alert", ESCALATE: "--escalate" };
const ICON = {
  rain_gauge: "💧", drainage_sensor: "🔧", traffic_sensor: "🚗", camera: "📷", hospital: "🏥",
  citizen_report: "👤", utility: "⚡", gateway: "📡", dispatch: "📞",
};
const FEED_SHOWN = 15;

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const hypColor = (h) => css(HYP_VAR[h]);
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const pct = (x, d = 0) => `${(100 * x).toFixed(d)}%`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const maxDiff = (a, b) => Math.max(...HYPS.map((h) => Math.abs(a.probabilities[h] - b.probabilities[h])));
async function post(path) {
  try { await fetch(path, { method: "POST" }); } catch { /* server gone: nothing to control */ }
}

// ---------- state ----------
const app = {
  mode: "single",
  scenarios: [],
  scenario: null,
  speed: 4,
  es: null, // the open EventSource
  streamId: null,
  paused: false,
  finished: false,
  pendingStep: false,
};
let S = freshSingle(); // single-mode episode state
let T = freshTwin(); // twin-mode state
let P = freshShift(); // prior-shift state

function freshSingle() {
  return { ticks: [], feed: [], retracted: new Set(), clusterOf: new Map(), selected: null, trustHist: {}, trustSel: null, start: null, reveal: null, hover: null };
}
function freshTwin() {
  return { left: [], right: [], split: null, start: null, feed: new Map(), reveal: null, divergence: null, hover: { left: null, right: null } };
}
function freshShift() {
  return { rows: [], length: 100, shiftAt: 50, threshold: 3, done: false, hover: null };
}

// ---------- probability bars ----------
function buildBars(el) {
  el.innerHTML = HYPS.map((h) => `
    <div class="bar" data-h="${h}">
      <span class="name">${HYP_LABEL[h]}</span>
      <span class="track"><span class="fill" style="background:var(${HYP_VAR[h]})"></span><span class="prev" style="left:0"></span></span>
      <span class="pct">—</span>
    </div>`).join("");
}
function setBars(el, now, prev) {
  for (const row of el.querySelectorAll(".bar")) {
    const h = row.dataset.h;
    const p = now ? now.probabilities[h] : 0;
    row.querySelector(".fill").style.width = pct(p, 2);
    row.querySelector(".pct").textContent = now ? pct(p, 1) : "—";
    const m = row.querySelector(".prev"); // last tick's value, so the direction is visible
    m.style.left = `calc(${pct(prev ? prev.probabilities[h] : p, 2)} - 1px)`;
    m.style.display = prev ? "block" : "none";
  }
}
function setBadge(badge, cost, rec) {
  badge.className = badge.className.replace(/\b(WATCH|PREPARE|ALERT|ESCALATE)\b/g, "").trim() + (rec ? ` ${rec.action}` : "");
  badge.textContent = rec ? rec.action : "—";
  cost.textContent = rec && Number.isFinite(rec.expected_cost) ? rec.expected_cost.toFixed(2) : "—";
}

// ---------- canvas helpers ----------
// Size the canvas backing store to its CSS size x devicePixelRatio, return a 2D context in CSS pixels.
function ctx2d(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.height / (canvas._dpr || 1);
  canvas._dpr = dpr;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = `${h}px`;
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, w, h };
}

// Stacked belief timeline: x = episode minutes, y = 0..1, bands bottom-up CASCADE, ISOLATED, SENSOR, NOISE.
const STACK = ["CASCADING_CRISIS", "ISOLATED_INCIDENT", "SENSOR_FAILURE", "NOISE"];
function drawTimeline(canvas, ticks, opts) {
  const { c, w, h } = ctx2d(canvas);
  const pad = { l: 34, r: 8, t: 14, b: 22 };
  const W = w - pad.l - pad.r;
  const H = h - pad.t - pad.b;
  const maxMin = Math.max(1, opts.durationMin || 45);
  const X = (min) => pad.l + (min / maxMin) * W;
  const Y = (p) => pad.t + (1 - p) * H;
  c.clearRect(0, 0, w, h);

  // grid + axes
  c.strokeStyle = css("--line");
  c.fillStyle = css("--muted");
  c.font = "11px " + css("--mono");
  c.lineWidth = 1;
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    c.beginPath(); c.moveTo(pad.l, Y(p)); c.lineTo(w - pad.r, Y(p)); c.stroke();
    c.fillText(p.toFixed(2), 2, Y(p) + 4);
  }
  for (let m = 0; m <= maxMin; m += 5) c.fillText(String(m), X(m) - 5, h - 6);

  // stacked areas
  if (ticks.length) {
    let lower = ticks.map(() => 0);
    for (const hName of STACK) {
      const upper = ticks.map((t, i) => lower[i] + t.record.probabilities[hName]);
      c.beginPath();
      c.moveTo(X(ticks[0].minute), Y(lower[0]));
      ticks.forEach((t, i) => c.lineTo(X(t.minute), Y(upper[i])));
      for (let i = ticks.length - 1; i >= 0; i--) c.lineTo(X(ticks[i].minute), Y(lower[i]));
      c.closePath();
      c.globalAlpha = 0.85;
      c.fillStyle = hypColor(hName);
      c.fill();
      c.globalAlpha = 1;
      lower = upper;
    }
    // action strip along the top: one colored segment per minute
    ticks.forEach((t) => {
      c.fillStyle = css(ACTION_VAR[t.record.action]);
      c.fillRect(X(t.minute - 1), 2, Math.max(1, X(1) - X(0)), 6);
    });
  }

  // vertical markers: split line, critical time (after the reveal)
  const vline = (min, label, color, dash, labelY) => {
    c.save();
    c.strokeStyle = color; c.fillStyle = color; c.setLineDash(dash); c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(X(min), pad.t); c.lineTo(X(min), pad.t + H); c.stroke();
    c.setLineDash([]); c.font = "bold 11px " + css("--sans");
    c.fillText(label, Math.min(X(min) + 4, w - 70), labelY);
    c.restore();
  };
  if (opts.splitMin !== undefined) vline(opts.splitMin, "SPLIT", css("--text"), [6, 4], pad.t + 12);
  if (opts.criticalMin !== undefined) vline(opts.criticalMin, "critical time", css("--escalate"), [2, 3], pad.t + H - 6);

  // hover line
  if (opts.hover !== null && opts.hover !== undefined && ticks[opts.hover]) {
    const t = ticks[opts.hover];
    c.strokeStyle = css("--text"); c.lineWidth = 1;
    c.beginPath(); c.moveTo(X(t.minute), pad.t); c.lineTo(X(t.minute), pad.t + H); c.stroke();
  }
  canvas._geom = { X, pad, W, maxMin };
}

// Hover on a timeline: find the nearest tick and show its exact numbers.
function attachHover(canvas, tip, getTicks, setHover, redraw) {
  canvas.addEventListener("mousemove", (e) => {
    const ticks = getTicks();
    const g = canvas._geom;
    if (!g || !ticks.length) return;
    const r = canvas.getBoundingClientRect();
    const min = ((e.clientX - r.left - g.pad.l) / g.W) * g.maxMin;
    let best = 0;
    ticks.forEach((t, i) => { if (Math.abs(t.minute - min) < Math.abs(ticks[best].minute - min)) best = i; });
    setHover(best);
    redraw();
    const t = ticks[best].record;
    tip.innerHTML = `<b class="num">${mmss(t.tick_time)}</b> · <b>${t.action}</b><br>` +
      HYPS.map((h) => `<span style="color:${hypColor(h)}">■</span> ${HYP_LABEL[h]} <span class="num">${t.probabilities[h].toFixed(3)}</span>`).join("<br>");
    tip.classList.remove("hidden");
    const x = e.clientX - r.left;
    tip.style.left = `${x > r.width / 2 ? x - tip.offsetWidth - 12 : x + 12}px`;
    tip.style.top = "10px";
  });
  canvas.addEventListener("mouseleave", () => { setHover(null); tip.classList.add("hidden"); redraw(); });
}

function legend(el) {
  el.innerHTML = STACK.slice().reverse().map((h) => `<span><i style="background:var(${HYP_VAR[h]})"></i>${HYP_LABEL[h]}</span>`).join("") +
    `<span>top strip = action: ${ACTIONS.map((a) => `<i style="background:var(${ACTION_VAR[a]})"></i>${a}`).join(" ")}</span>`;
}

// ---------- event feed ----------
// Add a tick's events to a feed list (newest first). Retractions strike their target.
function addFeed(list, retracted, tick) {
  for (const e of tick.events) {
    if (e.kind === "retraction" && e.retracts) retracted.add(e.retracts);
    list.unshift(e);
  }
}
function feedHtml(e, opts) {
  const tags = [];
  if (e.dup) tags.push('<span class="tag">DUP</span>');
  if (opts.retracted.has(e.id)) tags.push('<span class="tag RET">RET</span>');
  if (e.quarantined) tags.push('<span class="tag Q">Q</span>');
  const n = opts.clusterOf.get(e.id);
  if (n && n >= 2) tags.push(`<span class="tag">🔗cluster:${n}</span>`);
  if (opts.side) tags.push(`<span class="tag side">${opts.side}</span>`);
  const sev = e.severity !== undefined ? ` sev ${e.severity.toFixed(2)}` : "";
  const what = e.kind === "retraction" ? `retraction of ${esc(e.retracts)}` : `${esc(e.kind)} · ${esc(e.zone_id)}${sev}`;
  return `<div class="fe${opts.retracted.has(e.id) ? " ret" : ""}${opts.selected === e.id ? " sel" : ""}" data-id="${esc(e.id)}" title="${esc(e.source_id)}${e.text ? ": " + esc(e.text) : ""}">
    <span class="t">${mmss(e.arrived_at)}</span><span>${ICON[e.source_type] || "•"}</span>
    <span><span class="what">${what}</span>${tags.join("")}</span></div>`;
}

// ---------- single mode ----------
function renderSingle() {
  const ticks = S.ticks;
  const now = ticks[ticks.length - 1];
  const prev = ticks[ticks.length - 2];
  setBars($("s-bars"), now?.record, prev?.record);
  setBadge($("s-badge"), $("s-cost"), now?.record);
  $("clock").textContent = mmss(now ? now.record.tick_time : 0);
  drawSingleTimeline();
  renderForecast(now);
  renderWhy(now);
  renderFeed();
  renderTrust(now);
  renderBanners(now);
  const rv = $("s-reveal");
  if (S.reveal) {
    const r = S.reveal;
    rv.classList.remove("hidden");
    rv.innerHTML = `<h2>Truth revealed (episode over)</h2><b>${esc(r.hypothesis)}</b> · ${esc(r.group)} · episode ${esc(r.episode_id)}` +
      (r.critical_time !== undefined ? ` · critical time <span class="num">${mmss(r.critical_time)}</span>` : "") +
      (r.onset !== undefined ? ` · onset <span class="num">${mmss(r.onset)}</span>` : "");
  } else rv.classList.add("hidden");
}
function drawSingleTimeline() {
  drawTimeline($("s-timeline"), S.ticks, {
    durationMin: S.start ? S.start.ticks : 45,
    hover: S.hover,
    criticalMin: S.reveal?.critical_time !== undefined ? S.reveal.critical_time / 60 : undefined,
  });
}

function renderForecast(now) {
  const el = $("s-forecast");
  if (!now) { el.innerHTML = '<span class="muted">No forecast yet.</span>'; return; }
  const f = now.record.forecast;
  const st = now.forecast_status || {};
  const rows = f.map((x) => {
    const s = st[x.kind];
    const status = s === "confirmed" ? '<span class="status-confirmed">✓ confirmed</span>' : s === "missed" || s === "off_window" ? '<span class="status-missed">✗ missed</span>' : "⏳ pending";
    return `<div class="fc-row"><span><b>${esc(x.kind)}</b> <span class="muted">${esc(x.zones.join(", ") || "city")}</span></span>
      <span class="num">[${mmss(x.window_p10)} – ${mmss(x.window_p90)}]</span><span class="pill">${pct(x.probability)}</span><span>${status}</span></div>`;
  });
  // stages already resolved (they no longer appear as forecasts)
  const done = Object.entries(st).filter(([k]) => !f.some((x) => x.kind === k));
  if (done.length) rows.push(`<div class="fsum">Resolved so far: ${done.map(([k, v]) => `${esc(k)} ${v === "confirmed" ? '<span class="status-confirmed">✓</span>' : '<span class="status-missed">✗</span>'}`).join(" · ")}</div>`);
  el.innerHTML = rows.length ? rows.join("") : `<span class="muted">${esc(now.record.explanation.forecast_summary)}</span>`;
}

function renderWhy(now) {
  const el = $("s-why");
  if (!now) { el.innerHTML = '<span class="muted">Press Play.</span>'; return; }
  const x = now.record.explanation;
  const units = new Map(now.units.map((u) => [u.unit_id, u]));
  const selUnit = S.selected ? now.units.find((u) => u.members.includes(S.selected)) : undefined;
  const items = x.top_evidence.map((e) => {
    const u = units.get(e.unit_id);
    return `<div class="ev${selUnit && selUnit.unit_id === e.unit_id ? " sel" : ""}">${esc(e.description)}
      <div class="meta"><span>${esc(e.kind)}</span><span>${esc(e.zone_id || "")}</span>${u ? `<span>${u.n} event(s)</span>` : ""}
      <span class="hyp ${e.supports}">${HYP_LABEL[e.supports]}</span><span class="num">LLR ${e.llr >= 0 ? "+" : ""}${e.llr.toFixed(2)}</span></div></div>`;
  });
  let sel = "";
  if (S.selected) {
    if (!selUnit) sel = `Selected event ${esc(S.selected)} is not part of any scored evidence unit at ${mmss(now.record.tick_time)} (a heartbeat-like blip, quarantined, retracted, or outside the 15-minute window).`;
    else if (!x.top_evidence.some((e) => e.unit_id === selUnit.unit_id))
      sel = `Selected event is in unit ${esc(selUnit.unit_type)} ${esc(selUnit.kind)} ${esc(selUnit.zone_id)} (${selUnit.n} event(s), weight ${selUnit.weight.toFixed(2)}): LLR ${selUnit.llr >= 0 ? "+" : ""}${selUnit.llr.toFixed(2)} toward cascade, supports ${HYP_LABEL[selUnit.supports]}. Not in the top 3 this tick.`;
    else sel = "Selected event: its unit is highlighted above.";
  }
  el.innerHTML = `<p class="delta">${esc(x.delta_summary)}</p>${items.join("") || '<div class="muted">No evidence units yet.</div>'}
    ${sel ? `<div class="selnote">${sel}</div>` : ""}<div class="fsum">${esc(x.forecast_summary)}</div>`;
}

function renderFeed() {
  const el = $("s-feed");
  el.innerHTML = S.feed.slice(0, FEED_SHOWN).map((e) => feedHtml(e, { retracted: S.retracted, clusterOf: S.clusterOf, selected: S.selected })).join("");
  $("s-feedcount").textContent = S.feed.length ? `(last ${Math.min(FEED_SHOWN, S.feed.length)} of ${S.feed.length})` : "";
}

// Trust panel: per source TYPE, live/stale/dark counts and mean trust.
function trustByType(now) {
  const types = {};
  for (const s of S.start.registry.sources) {
    const t = (types[s.source_type] ||= { live: 0, stale: 0, dark: 0, n: 0, mean: 0, a: 0, b: 0 });
    t.n++;
    t[now.record.source_statuses[s.source_id] || "live"]++;
  }
  for (const tr of now.record.trust) {
    const t = types[tr.source_type];
    if (!t) continue;
    t.mean += tr.mean / t.n; t.a += tr.alpha / t.n; t.b += tr.beta / t.n;
  }
  return types;
}
function renderTrust(now) {
  const grid = $("trust-grid");
  if (!now || !S.start) { grid.innerHTML = ""; $("trust-sum").textContent = ""; return; }
  const types = trustByType(now);
  const s = now.record.source_summary;
  $("trust-sum").textContent = `· ${s.live} live, ${s.stale} stale, ${s.dark} dark of ${s.total}`;
  grid.innerHTML = `<tr><th>source</th><th>live</th><th>stale</th><th>dark</th><th>mean trust</th></tr>` +
    Object.entries(types).sort().map(([k, t]) => `<tr data-type="${k}" class="${t.dark ? "dark" : ""}${S.trustSel === k ? " sel" : ""}">
      <td>${ICON[k] || ""} ${k}</td><td>${t.live}</td><td>${t.stale}</td><td>${t.dark}</td><td class="num">${t.mean.toFixed(2)}</td></tr>`).join("");
  renderTrustDetail();
}
function renderTrustDetail() {
  const el = $("trust-detail");
  const k = S.trustSel;
  const hist = k ? S.trustHist[k] || [] : [];
  if (!k || !hist.length) { el.innerHTML = "Click a source type to see its trust over this episode."; return; }
  const last = hist[hist.length - 1];
  // sparkline: mean trust per tick, scaled to its own min..max so small in-episode bumps show
  const lo = Math.min(...hist.map((x) => x.mean));
  const hi = Math.max(...hist.map((x) => x.mean));
  const pts = hist.map((x, i) => `${(i / Math.max(1, hist.length - 1)) * 200},${28 - (hi > lo ? ((x.mean - lo) / (hi - lo)) * 24 : 12)}`).join(" ");
  el.innerHTML = `<b>${ICON[k] || ""} ${k}</b>: mean trust ${last.mean.toFixed(3)}, average Beta(${last.a.toFixed(2)}, ${last.b.toFixed(2)}) over ${hist.length} ticks (range ${lo.toFixed(3)}–${hi.toFixed(3)})<br>
    <svg width="200" height="30" viewBox="0 0 200 30"><polyline fill="none" stroke="currentColor" stroke-width="1.5" points="${pts}"/></svg>`;
}

function renderBanners(now) {
  const d = $("b-degraded");
  if (now && now.record.degraded && !now.record.fallback) {
    d.textContent = `DEGRADED — coverage at ${pct(now.coverage_weighted)}, confidence widened` +
      (S.start?.demo_threshold ? ` (demo threshold: below ${pct(now.degraded_threshold)} trust-weighted coverage; engine default 50%)` : "");
    d.classList.remove("hidden");
  } else d.classList.add("hidden");
  $("b-fallback").classList.toggle("hidden", !(now && now.record.fallback));
}

function onSingleTick(tick) {
  S.ticks.push(tick);
  addFeed(S.feed, S.retracted, tick);
  S.clusterOf = new Map();
  for (const u of tick.units) if (u.n >= 2) for (const id of u.members) S.clusterOf.set(id, u.n);
  if (S.start) for (const [k, t] of Object.entries(trustByType(tick))) (S.trustHist[k] ||= []).push({ mean: t.mean, a: t.a, b: t.b });
  renderSingle();
}

// ---------- twin mode ----------
function renderTwin() {
  for (const side of ["left", "right"]) {
    const ticks = T[side];
    const now = ticks[ticks.length - 1];
    setBars($(`t-${side}-bars`), now?.record, ticks[ticks.length - 2]?.record);
    setBadge($(`t-${side}-badge`), $(`t-${side}-cost`), now?.record);
    drawTimeline($(`t-${side}-timeline`), ticks, {
      durationMin: T.start ? T.start.ticks : 45,
      splitMin: T.split !== null ? T.split / 60 : undefined,
      hover: T.hover[side],
      criticalMin: T.reveal?.[side]?.critical_time !== undefined ? T.reveal[side].critical_time / 60 : undefined,
    });
  }
  const n = Math.min(T.left.length, T.right.length);
  const last = T.left[n - 1];
  $("clock").textContent = mmss(last ? last.record.tick_time : 0);

  // identity check before the split, then which side is moving away
  if (T.split !== null && n) {
    const pre = [];
    for (let i = 0; i < n; i++) if (T.left[i].record.tick_time <= T.split) pre.push(maxDiff(T.left[i].record, T.right[i].record));
    const ok = pre.every((d) => d < 1e-9);
    const after = last.record.tick_time > T.split;
    $("t-identity").innerHTML = `Pre-split check: <b style="color:var(${ok ? "--noise" : "--cascade"})">${pre.length} of ${pre.length} ticks ${ok ? "identical" : "NOT identical"}</b> (max |ΔP| = ${Math.max(0, ...pre).toExponential(1)}) · split at <span class="num">${mmss(T.split)}</span>` +
      (after ? ` · now |ΔP| = <span class="num">${maxDiff(T.left[n - 1].record, T.right[n - 1].record).toFixed(3)}</span>` : "");
    const atSplit = (ticks) => ticks.filter((t) => t.record.tick_time <= T.split).pop();
    for (const side of ["left", "right"]) {
      const el = $(`t-${side}`);
      const state = $(`t-${side}-state`);
      if (!after) { el.className = "card twin same"; state.textContent = "Identical prefix"; continue; }
      const other = side === "left" ? "right" : "left";
      const move = (s) => Math.abs(T[s][n - 1].record.probabilities.CASCADING_CRISIS - atSplit(T[s]).record.probabilities.CASCADING_CRISIS);
      const diverging = move(side) >= move(other);
      el.className = `card twin ${diverging ? "diverge" : ""}`;
      state.textContent = diverging ? "Diverging" : "After split";
    }
    // the first tick where the posteriors differ by more than 0.05
    if (!T.divergence) for (let i = 0; i < n; i++) {
      if (T.left[i].record.tick_time > T.split && maxDiff(T.left[i].record, T.right[i].record) > 0.05) { T.divergence = i; break; }
    }
    const i = T.divergence;
    $("t-callout").innerHTML = i === null || i === undefined ? '<span class="muted">No difference above 0.05 yet.</span>' :
      `First tick with |ΔP| > 0.05: <b class="num">${mmss(T.left[i].record.tick_time)}</b> (${((T.left[i].record.tick_time - T.split) / 60).toFixed(0)} min after the split)
       <div class="callout" style="margin-top:8px">
         <div><b>Twin A</b>: P(cascade) ${T.left[i].record.probabilities.CASCADING_CRISIS.toFixed(2)} · ${T.left[i].record.action}<br>${esc(T.left[i].record.explanation.delta_summary)}</div>
         <div><b>Twin B</b>: P(cascade) ${T.right[i].record.probabilities.CASCADING_CRISIS.toFixed(2)} · ${T.right[i].record.action}<br>${esc(T.right[i].record.explanation.delta_summary)}</div>
       </div>`;
  }
  // shared feed: an event both twins received has no tag; otherwise A or B
  const all = [...T.feed.values()].sort((a, b) => b.e.arrived_at - a.e.arrived_at || (a.e.id < b.e.id ? 1 : -1));
  const retracted = new Set(all.filter((x) => x.e.retracts).map((x) => x.e.retracts));
  $("t-feed").innerHTML = all.slice(0, FEED_SHOWN).map((x) => feedHtml(x.e, { retracted, clusterOf: new Map(), side: x.sides.size === 2 ? "" : x.sides.has("left") ? "A only" : "B only" })).join("");
  $("t-feedcount").textContent = all.length ? `(last ${Math.min(FEED_SHOWN, all.length)} of ${all.length})` : "";
  const rv = $("t-reveal");
  if (T.reveal) {
    rv.classList.remove("hidden");
    rv.innerHTML = `<h2>Truth revealed</h2>Twin A: <b>${esc(T.reveal.left.hypothesis)}</b> (${esc(T.reveal.left.twin_role)}) · Twin B: <b>${esc(T.reveal.right.hypothesis)}</b> (${esc(T.reveal.right.twin_role)})`;
  } else rv.classList.add("hidden");
  renderBanners(undefined);
}
function onTwinTick(side, tick) {
  T[side].push(tick);
  for (const e of tick.events) {
    const k = e.id + "|" + e.arrived_at;
    const x = T.feed.get(k) || { e, sides: new Set() };
    x.sides.add(side);
    T.feed.set(k, x);
  }
  if (side === "right") renderTwin();
}

// ---------- prior-shift mode ----------
function renderShift() {
  const canvas = $("p-chart");
  const { c, w, h } = ctx2d(canvas);
  const pad = { l: 40, r: 40, t: 16, b: 24 };
  const W = w - pad.l - pad.r;
  const H = h - pad.t - pad.b;
  const X = (ep) => pad.l + ((ep - 1) / (P.length - 1)) * W;
  const Yp = (p) => pad.t + (1 - p / 0.4) * H; // prior axis 0..0.4 (left)
  const Yb = (b) => pad.t + (1 - b / 1.0) * H; // Brier axis 0..1 (right)
  c.clearRect(0, 0, w, h);
  c.strokeStyle = css("--line"); c.fillStyle = css("--muted"); c.font = "11px " + css("--mono");
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (i / 4) * H;
    c.beginPath(); c.moveTo(pad.l, y); c.lineTo(w - pad.r, y); c.stroke();
    c.fillText((0.4 * (1 - i / 4)).toFixed(2), 4, y + 4);
    c.fillText((1 - i / 4).toFixed(2), w - pad.r + 4, y + 4);
  }
  for (const ep of [1, 25, 50, 75, 100]) c.fillText(String(ep), X(ep) - 6, h - 6);
  // regime change line
  c.save(); c.setLineDash([6, 4]); c.strokeStyle = css("--text");
  c.beginPath(); c.moveTo(X(P.shiftAt + 0.5), pad.t); c.lineTo(X(P.shiftAt + 0.5), pad.t + H); c.stroke(); c.restore();
  c.fillStyle = css("--text"); c.font = "bold 11px " + css("--sans");
  c.fillText("Regime change", X(P.shiftAt + 0.5) + 5, pad.t + 12);

  const rows = P.rows;
  const line = (vals, color, Y, dash = []) => {
    c.save(); c.strokeStyle = color; c.lineWidth = 2; c.setLineDash(dash); c.beginPath();
    vals.forEach(([ep, v], i) => (i ? c.lineTo(X(ep), Y(v)) : c.moveTo(X(ep), Y(v))));
    c.stroke(); c.restore();
  };
  line(rows.map((r) => [r.episode, r.prior_used.CASCADING_CRISIS]), css("--cascade"), Yp);
  // running (cumulative) Brier, restarted at the regime change
  const running = (key) => {
    const out = [];
    let sum = 0; let n = 0;
    for (const r of rows) {
      if (r.episode === P.shiftAt + 1) { sum = 0; n = 0; }
      sum += r[key]; n++;
      out.push([r.episode, sum / n]);
    }
    return out;
  };
  line(running("brier_static"), css("--muted"), Yb, [5, 4]);
  line(running("brier"), css("--text"), Yb);
  for (const r of rows) if (r.cusum_alarm) { c.fillStyle = css("--alert"); c.fillText("⚡", X(r.episode) - 5, pad.t + 26); }
  if (P.hover !== null && rows[P.hover]) {
    const r = rows[P.hover];
    c.strokeStyle = css("--text"); c.beginPath(); c.moveTo(X(r.episode), pad.t); c.lineTo(X(r.episode), pad.t + H); c.stroke();
  }
  canvas._geom = { X, pad, W };

  // dots: true hypothesis per episode
  const dots = $("p-dots");
  if (dots.children.length !== P.length) dots.innerHTML = Array.from({ length: P.length }, (_, i) => `<span class="dot" title="episode ${i + 1}"></span>`).join("");
  rows.forEach((r, i) => {
    const d = dots.children[i];
    d.style.background = `var(${HYP_VAR[r.truth]})`;
    d.title = `episode ${r.episode}: ${r.group} (${r.truth})`;
    d.classList.toggle("bolt", r.cusum_alarm);
  });
  const last = rows[rows.length - 1];
  $("clock").textContent = last ? `ep ${last.episode}` : "00:00";

  const alarms = rows.filter((r) => r.cusum_alarm).map((r) => r.episode);
  const maxS = Math.max(0, ...rows.map((r) => r.cusum_S));
  $("p-cusum").innerHTML = alarms.length ? `⚡ <b>Drift detected at episode ${alarms.join(", ")}</b> (CUSUM above ${P.threshold})` :
    `No drift alarm${P.done ? "" : " yet"}: CUSUM peaked at <span class="num">${maxS.toFixed(2)}</span>, alarm threshold ${P.threshold}.` +
    (P.done ? " (On 9 of 10 dev-seeded copies of this sequence it did fire, around episode 70.)" : "");

  // halves
  const half = (a, b) => rows.filter((r) => r.episode > a && r.episode <= b);
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
  const h1 = half(0, P.shiftAt);
  const h2 = half(P.shiftAt, P.length);
  const casc = (xs) => xs.filter((r) => r.truth === "CASCADING_CRISIS").length;
  const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "—");
  $("p-stats").innerHTML = [
    ["Brier 1-50: adaptive / static", `${f3(mean(h1.map((r) => r.brier)))} / ${f3(mean(h1.map((r) => r.brier_static)))}`],
    ["Brier 51-100: adaptive / static", `${f3(mean(h2.map((r) => r.brier)))} / ${f3(mean(h2.map((r) => r.brier_static)))}`],
    ["True cascades 1-50 / 51-100", `${casc(h1)} / ${casc(h2)}`],
    ["P(cascade) prior at ep 25 / 75", `${f3(rows[24]?.prior_used.CASCADING_CRISIS)} / ${f3(rows[74]?.prior_used.CASCADING_CRISIS)}`],
  ].map(([k, v]) => `<div class="stat"><div class="muted">${k}</div><div class="v">${v}</div></div>`).join("");
  if (P.done) {
    const a = mean(h2.map((r) => r.brier));
    const s = mean(h2.map((r) => r.brier_static));
    $("p-verdict").innerHTML = a < s
      ? `After the regime change the adaptive prior beats the static prior on Brier (${f3(a)} vs ${f3(s)}).`
      : `<b>Honest result:</b> the prior adapts as designed (it rises after episode ${P.shiftAt}), but after the regime change the adaptive engine's Brier is <b>not</b> better than the static prior's (${f3(a)} vs ${f3(s)}, lower is better). The evidence inside each episode soon outweighs the prior, and a 20-episode memory is noisy. This is the Phase 4 gate item that was missed.`;
  } else $("p-verdict").textContent = "";
}

// ---------- eval mode ----------
async function loadEval() {
  const split = $("eval-split").value;
  $("eval-table").textContent = split === "test" ? "Loading…" : "Loading (if this split was never evaluated, the server runs the eval now: about 30-60 s)…";
  $("eval-breakdown").innerHTML = "";
  let v;
  try {
    const r = await fetch(`/api/eval?split=${split}`);
    v = await r.json();
    if (!r.ok) throw new Error(v.error || r.statusText);
  } catch (e) {
    $("eval-table").textContent = `Could not load the eval: ${e.message}`;
    return;
  }
  const NAME = { engine: "engine (tuned)", "engine-handset": "engine (hand-set)", "count-threshold": "count-threshold", "always-watch": "always-watch" };
  const order = ["engine", "engine-handset", "count-threshold", "always-watch"];
  const pols = order.map((n) => v.policies.find((p) => p.name === n)).filter(Boolean);
  const f = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(d));
  const cols = [
    ["Brier ↓", (s) => s.brier, (x) => f(x), "min"],
    ["Log-loss ↓", (s) => s.log_loss, (x) => f(x), "min"],
    ["False alarms ↓", (s) => s.false_alarm_rate, (x, s) => `${f(100 * x, 1)}% <span class="muted">(${s.false_alarms}/${s.benign})</span>`, "min"],
    ["Cost / tick ↓", (s) => s.cost_per_tick, (x) => f(x, 2), "min"],
    ["Lead time (min) ↑", (s) => s.mean_lead_min, (x, s) => `${f(x, 2)} <span class="muted">(${s.cascades_alerted}/${s.cascades})</span>`, "max"],
    ["Flip-flops / ep ↓", (s) => s.flips_per_episode, (x) => f(x, 2), "min"],
    ["Forecast acc. ↑", (s) => s.forecast_accuracy, (x) => (Number.isFinite(x) ? `${f(100 * x, 1)}%` : "—"), "max"],
  ];
  const best = cols.map(([, get, , dir]) => {
    const xs = pols.map((p) => get(p.summary)).filter((x) => x !== null && Number.isFinite(x));
    return dir === "min" ? Math.min(...xs) : Math.max(...xs);
  });
  $("eval-table").innerHTML = `<table class="evtable"><tr><th>policy (${v.split}, ${pols[0]?.summary.episodes} episodes)</th>${cols.map((c) => `<th>${c[0]}</th>`).join("")}</tr>` +
    pols.map((p) => `<tr><td>${NAME[p.name] || p.name}</td>${cols.map(([, get, fmt], i) => {
      const x = get(p.summary);
      return `<td class="num${x === best[i] && pols.length > 1 ? " win" : ""}">${fmt(x, p.summary)}</td>`;
    }).join("")}</tr>`).join("") + "</table>" +
    `<div class="muted" style="margin-top:6px;font-size:12px">Numbers read from data/eval-results.json (${v.source === "cache" ? "written by npm run eval" : "computed now with the eval code and saved there"}). Green = best in column. Lead time = minutes before the critical time (negative = after).</div>`;
  $("eval-limit").textContent = v.limitation;

  // breakdown by episode type
  const groups = Object.keys(pols[0]?.groups || {}).sort();
  $("eval-breakdown").innerHTML = groups.map((g) => {
    const sum = pols[0].groups[g];
    const rows = pols.map((p) => {
      const s = p.groups[g];
      const alert = s.cascades ? `${s.cascades_alerted}/${s.cascades} cascades alerted` : s.benign ? `${s.false_alarms}/${s.benign} false alarms` : "—";
      return `<tr><td>${NAME[p.name] || p.name}</td><td class="num">${f(s.brier)}</td><td class="num">${f(s.cost_per_tick, 2)}</td><td>${alert}</td><td class="num">${f(s.flips_per_episode, 2)}</td></tr>`;
    }).join("");
    return `<details><summary><b>${esc(g)}</b> <span class="muted">${sum.episodes} episodes · engine Brier ${f(sum.brier)}</span></summary>
      <table class="evtable"><tr><th>policy</th><th>Brier</th><th>Cost / tick</th><th>ALERT+</th><th>Flips / ep</th></tr>${rows}</table></details>`;
  }).join("");
}

// ---------- streams ----------
function closeStream() {
  if (app.es) app.es.close();
  app.es = null;
  app.streamId = null;
  app.paused = false;
}
function resetAll() {
  closeStream();
  app.finished = false;
  S = freshSingle();
  T = freshTwin();
  P = freshShift();
  render();
}

function startStream(paused = false) {
  closeStream();
  app.finished = false;
  const sp = `speed=${app.speed}${paused ? "&paused=1" : ""}`;
  let url;
  if (app.mode === "single") {
    S = freshSingle();
    // The Cutout scenario asks for its demo-only DEGRADED threshold (0.8) in the URL; eval uses the default 0.5.
    const deg = app.scenario.degradedBelow !== undefined ? `&degraded_threshold=${app.scenario.degradedBelow}` : "";
    url = `/api/replay?split=${app.scenario.split}&episode=${app.scenario.episode}${deg}&${sp}`;
  } else if (app.mode === "twin") {
    T = freshTwin();
    url = `/api/twin?split=${app.scenario.split}&twin=${app.scenario.twin}&${sp}`;
  } else if (app.mode === "shift") {
    P = freshShift();
    url = `/api/prior-shift?${sp}`;
  } else return;
  app.paused = paused;
  const es = new EventSource(url);
  app.es = es;
  const on = (name, fn) => es.addEventListener(name, (m) => fn(JSON.parse(m.data)));
  on("episode-start", (d) => {
    app.streamId = d.stream_id;
    if (app.pendingStep) { app.pendingStep = false; post(`/api/replay/step?id=${d.stream_id}`); }
    if (app.mode === "single") { S.start = d; renderSingle(); }
    if (app.mode === "twin") { T.start = d; T.split = d.split_time; renderTwin(); }
    if (app.mode === "shift") { P.length = d.length; P.shiftAt = d.shift_at; P.threshold = d.cusum_threshold; renderShift(); }
  });
  on("tick", onSingleTick);
  on("tick-left", (d) => onTwinTick("left", d));
  on("tick-right", (d) => onTwinTick("right", d));
  on("split", (d) => { T.split = d.split_time; });
  on("episode-summary", (d) => { P.rows.push(d); renderShift(); });
  on("episode-end", (d) => {
    // close now, or EventSource would reconnect and replay the episode again
    closeStream();
    app.finished = true;
    if (app.mode === "single") { S.reveal = d; renderSingle(); }
    if (app.mode === "twin") { T.reveal = d; renderTwin(); }
    if (app.mode === "shift") { P.done = true; renderShift(); }
    updateButtons();
  });
  es.onerror = () => { if (app.es === es) { closeStream(); updateButtons(); } };
  updateButtons();
}

function play() {
  if (app.mode === "eval") return;
  if (app.es && app.paused) { app.paused = false; post(`/api/replay/resume?id=${app.streamId}`); }
  else if (!app.es) startStream(false);
  updateButtons();
}
function pause() {
  if (!app.es) return;
  app.paused = true;
  post(`/api/replay/pause?id=${app.streamId}`);
  updateButtons();
}
function step() {
  if (app.mode === "eval") return;
  if (!app.es) { startStream(true); app.pendingStep = true; return; } // stepped once the stream id arrives
  if (app.paused) post(`/api/replay/step?id=${app.streamId}`);
  else pause();
}
function setSpeed(s) {
  app.speed = s;
  for (const b of document.querySelectorAll("#speeds button")) b.classList.toggle("on", Number(b.dataset.speed) === s);
  if (app.streamId) post(`/api/replay/speed?id=${app.streamId}&speed=${s}`);
}

function setMode(mode) {
  if (mode === app.mode) return;
  closeStream();
  app.mode = mode;
  // keep the scenario picker consistent with the mode
  if (mode === "twin" && app.scenario?.mode !== "twin") pickScenario(app.scenarios.find((s) => s.mode === "twin")?.id, false);
  if (mode === "single" && app.scenario?.mode !== "single") pickScenario(app.scenarios.find((s) => s.mode === "single")?.id, false);
  resetAll();
  if (mode === "eval") loadEval();
}
function pickScenario(id, reset = true) {
  app.scenario = app.scenarios.find((s) => s.id === id) || app.scenarios[0];
  $("scenario").value = app.scenario.id;
  if (reset) {
    if (app.scenario.mode !== app.mode && (app.mode === "single" || app.mode === "twin")) app.mode = app.scenario.mode;
    else if (app.mode === "shift" || app.mode === "eval") app.mode = app.scenario.mode;
    resetAll();
  }
}

function updateButtons() {
  const streaming = app.mode === "single" || app.mode === "twin" || app.mode === "shift";
  $("play").disabled = !streaming || (app.es && !app.paused);
  $("pause").disabled = !app.es || app.paused;
  $("step").disabled = !streaming || (app.es && !app.paused);
  $("reset").disabled = !streaming;
  $("scenario").disabled = !(app.mode === "single" || app.mode === "twin");
  for (const b of document.querySelectorAll("#modes button")) b.classList.toggle("on", b.dataset.mode === app.mode);
}

function render() {
  for (const m of ["single", "twin", "shift", "eval"]) $(`view-${m}`).classList.toggle("hidden", m !== app.mode);
  const desc = app.mode === "shift" ? "100 episodes in order. From episode 51 the city silently enters a monsoon regime (more cascades and rain days). The engine learns its base rates from each revealed outcome."
    : app.mode === "eval" ? "Every policy over every episode of a split, scored against the hidden truth (the same numbers as npm run eval)."
    : app.scenario ? `${app.scenario.label}: ${app.scenario.description}` : "";
  $("scenario-desc").textContent = desc;
  if (app.mode === "single") renderSingle();
  if (app.mode === "twin") renderTwin();
  if (app.mode === "shift") renderShift();
  if (app.mode !== "single") renderBanners(undefined);
  if (app.mode === "eval") $("clock").textContent = "—";
  updateButtons();
}

// ---------- wiring ----------
function initTheme() {
  let t = "dark";
  try { t = localStorage.getItem("f10m-theme") || "dark"; } catch { /* storage blocked */ }
  document.documentElement.dataset.theme = t;
  $("theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("f10m-theme", next); } catch { /* ignore */ }
    render();
  });
}

async function init() {
  initTheme();
  buildBars($("s-bars"));
  buildBars($("t-left-bars"));
  buildBars($("t-right-bars"));
  legend($("s-legend"));
  try {
    app.scenarios = await (await fetch("/api/scenarios")).json();
  } catch {
    $("scenario-desc").textContent = "Could not reach the server. Run: npm run dev";
    return;
  }
  $("scenario").innerHTML = app.scenarios.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("");
  $("scenario").addEventListener("change", (e) => pickScenario(e.target.value));
  pickScenario(app.scenarios.find((s) => s.id === "cascade")?.id ?? app.scenarios[0].id, false);

  $("play").addEventListener("click", play);
  $("pause").addEventListener("click", pause);
  $("step").addEventListener("click", step);
  $("reset").addEventListener("click", resetAll);
  for (const b of document.querySelectorAll("#speeds button")) b.addEventListener("click", () => setSpeed(Number(b.dataset.speed)));
  for (const b of document.querySelectorAll("#modes button")) b.addEventListener("click", () => setMode(b.dataset.mode));
  $("eval-split").addEventListener("change", loadEval);

  // click an event in the feed -> highlight its unit in "why it changed"
  $("s-feed").addEventListener("click", (e) => {
    const row = e.target.closest(".fe");
    if (!row) return;
    S.selected = S.selected === row.dataset.id ? null : row.dataset.id;
    renderSingle();
  });
  // click a source type -> its trust history
  $("trust-grid").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-type]");
    if (!row) return;
    S.trustSel = S.trustSel === row.dataset.type ? null : row.dataset.type;
    renderSingle();
  });

  attachHover($("s-timeline"), $("s-tip"), () => S.ticks, (i) => (S.hover = i), drawSingleTimeline);
  for (const side of ["left", "right"]) attachHover($(`t-${side}-timeline`), $(`t-${side}-tip`), () => T[side], (i) => (T.hover[side] = i), renderTwin);
  // prior-shift hover
  $("p-chart").addEventListener("mousemove", (e) => {
    const g = $("p-chart")._geom;
    if (!g || !P.rows.length) return;
    const r = $("p-chart").getBoundingClientRect();
    const ep = Math.round(((e.clientX - r.left - g.pad.l) / g.W) * (P.length - 1)) + 1;
    const i = Math.max(0, Math.min(P.rows.length - 1, ep - 1));
    P.hover = i;
    renderShift();
    const row = P.rows[i];
    const tip = $("p-tip");
    tip.innerHTML = `<b>episode ${row.episode}</b> · ${esc(row.group)}<br>prior P(cascade) <span class="num">${row.prior_used.CASCADING_CRISIS.toFixed(3)}</span><br>Brier adaptive <span class="num">${row.brier.toFixed(3)}</span> · static <span class="num">${row.brier_static.toFixed(3)}</span><br>CUSUM S <span class="num">${row.cusum_S.toFixed(2)}</span>`;
    tip.classList.remove("hidden");
    const x = e.clientX - r.left;
    tip.style.left = `${x > r.width / 2 ? x - tip.offsetWidth - 12 : x + 12}px`;
    tip.style.top = "10px";
  });
  $("p-chart").addEventListener("mouseleave", () => { P.hover = null; $("p-tip").classList.add("hidden"); renderShift(); });

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    if (e.key === " ") { e.preventDefault(); app.es && !app.paused ? pause() : play(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(); }
    else if (e.key === "r" || e.key === "R") resetAll();
    else if (e.key === "1" || e.key === "2" || e.key === "4") setSpeed(Number(e.key));
  });
  window.addEventListener("resize", () => render());
  render();
}

init();
