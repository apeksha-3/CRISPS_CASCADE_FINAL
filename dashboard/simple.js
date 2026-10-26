// dashboard/simple.js
// The user-facing layers and the mode / view switches. Layer 1 (status, one sentence, confidence, what to do) is the default;
// Layer 2 (zones, threat line, what's happening / expected, alert log) opens on request; Layer 3 is the existing dashboard (app.js)
// for the rules engine, and a technical panel (below) for the ML nowcast.
// All wording comes from the server (server/simple.ts, ml/text.ts): this file only draws it. No probability vectors, log-likelihoods or
// Brier scores are on the simple view.
"use strict";

const U = {
  mode: "rules", // "rules" | "nowcast"
  view: "simple", // "simple" | "technical"
  scenarios: [], // single-mode rules scenarios
  events: [], // the 3 real events
  calibration: null,
  pick: null,
  speed: 4,
  es: null,
  streamId: null,
  paused: false,
  finished: false,
  pendingStep: false,
  ticks: [],
  total: 0,
  idx: -1, // the tick being shown
  follow: true, // keep showing the newest tick
  log: [], // alert log: {i, text}
  more: false,
};

const RULES_COLOR = { WATCH: "l-WATCH", PREPARE: "l-PREPARE", ALERT: "l-ALERT", ESCALATE: "l-ESCALATE" };
const LEVEL_NAMES = { rules: ["Watch", "Prepare", "Alert", "Escalate"], nowcast: ["Low", "Elevated", "High"] };
const SEV_WORD = ["quiet", "some activity", "busy", "very busy"];

// ---- one-line plain-language tooltips for every metric label (technical views) ----
const TIPS = [
  [/log-?loss/i, "Log-loss: punishes confident wrong answers very hard. Lower is better."],
  [/brier/i, "Brier score: how far the stated probabilities were from what happened. 0 is perfect, lower is better."],
  [/false alarm/i, "False alarm rate: the share of calm episodes where the system raised ALERT or higher. Lower is better."],
  [/lead time/i, "Lead time: minutes between the first ALERT and the moment damage starts. Negative means the alert came late."],
  [/cost/i, "Cost per tick: the average cost of the chosen actions each minute, from the cost table. Lower is better."],
  [/flip/i, "Flip-flops: how often the recommendation reversed direction. Fewer means a steadier recommendation."],
  [/forecast acc/i, "Forecast accuracy: the share of forecast stages that really happened inside the predicted window."],
  [/\bECE\b|calibration error/i, "Expected calibration error: on average, how far 'X%' was from how often it really happened. Lower is better."],
  [/\bAUC\b/i, "AUC: the chance the model ranks a real event above a non-event. 0.5 is a coin flip, 1 is perfect."],
  [/ALERT\+/i, "ALERT+: the share of episodes where the system ever reached ALERT or ESCALATE."],
  [/reliability/i, "Reliability table: forecasts grouped by their stated chance, with how often the event really happened in each group."],
  [/positive rate/i, "Positive rate: the share of ticks where the event really happened in the next hour."],
];
function applyTips(root) {
  for (const el of root.querySelectorAll("th, h2, summary, .tip-label, td:first-child, .stats .k, .stats div:first-child")) {
    if (el.hasAttribute("data-tip") || el.children.length > 3) continue;
    const t = el.textContent.trim();
    if (!t || t.length > 90) continue;
    const hit = TIPS.find(([re]) => re.test(t));
    if (hit) { el.setAttribute("data-tip", hit[1]); el.setAttribute("tabindex", "0"); }
  }
}
function watchTips() {
  let timer = null;
  const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => { applyTips($("tech-root")); applyTips($("nowcast-tech")); }, 60); });
  for (const id of ["tech-root", "nowcast-tech"]) obs.observe($(id), { childList: true, subtree: true });
  applyTips($("tech-root"));
}

// ---- stream ----
function closeU() {
  if (U.es) U.es.close();
  U.es = null;
  U.streamId = null;
  U.paused = false;
}
function resetU() {
  closeU();
  U.ticks = []; U.log = []; U.idx = -1; U.follow = true; U.finished = false; U.total = 0; U.pendingStep = false;
  renderU();
}
function urlU(paused) {
  const sp = `speed=${U.speed}${paused ? "&paused=1" : ""}`;
  if (U.mode === "nowcast") return `/api/nowcast/replay?event=${U.pick}&${sp}`;
  const sc = U.scenarios.find((s) => s.id === U.pick) || U.scenarios[0];
  const deg = sc.degradedBelow !== undefined ? `&degraded_threshold=${sc.degradedBelow}` : "";
  return `/api/simple/replay?split=${sc.split}&episode=${sc.episode}${deg}&${sp}`;
}
function startU(paused = false) {
  closeU();
  U.ticks = []; U.log = []; U.idx = -1; U.follow = true; U.finished = false;
  const es = new EventSource(urlU(paused));
  U.es = es;
  U.paused = paused;
  es.addEventListener("episode-start", (m) => {
    const d = JSON.parse(m.data);
    U.streamId = d.stream_id;
    U.total = d.ticks;
    if (U.pendingStep) { U.pendingStep = false; post(`/api/replay/step?id=${d.stream_id}`); }
    renderU();
  });
  es.addEventListener("tick", (m) => {
    const d = JSON.parse(m.data);
    d.i = U.ticks.length;
    U.ticks.push(d);
    logChange(d);
    if (U.follow) U.idx = U.ticks.length - 1;
    renderU();
  });
  es.addEventListener("episode-end", () => { closeU(); U.finished = true; renderU(); });
  es.onerror = () => { if (U.es === es) { closeU(); renderU(); } };
  renderU();
}
function playU() {
  if (U.es && U.paused) { U.paused = false; post(`/api/replay/resume?id=${U.streamId}`); }
  else if (!U.es) startU(false);
  renderU();
}
function pauseU() { if (U.es) { U.paused = true; post(`/api/replay/pause?id=${U.streamId}`); renderU(); } }
function stepU() {
  if (!U.es) { U.pendingStep = true; startU(true); return; }
  if (U.paused) post(`/api/replay/step?id=${U.streamId}`); else pauseU();
}
function speedU(s) {
  U.speed = s;
  for (const b of document.querySelectorAll("#u-speeds button")) b.classList.toggle("on", Number(b.dataset.s) === s);
  if (U.streamId) post(`/api/replay/speed?id=${U.streamId}&speed=${s}`);
}

// ---- the alert log: one line whenever the recommendation changes ----
function stateKey(d) { return U.mode === "rules" ? d.view.status : (d.view.level ?? "none"); }
function stateWord(d) { return U.mode === "rules" ? d.view.label : (d.view.level ?? "forecast hidden"); }
function when(d) { return U.mode === "rules" ? `Minute ${d.minute}` : d.time; }
function logChange(d) {
  const prev = U.ticks[d.i - 1];
  if (!prev) { U.log.push({ i: d.i, text: `${when(d)}: starts at ${stateWord(d)}` }); return; }
  if (stateKey(prev) !== stateKey(d)) U.log.push({ i: d.i, text: `${when(d)}: ${stateWord(prev)} → ${stateWord(d)}` });
}

// ---- drawing ----
function cur() { return U.idx >= 0 ? U.ticks[U.idx] : null; }

function renderU() {
  const d = cur();
  const status = $("u-status");
  const nowcast = U.mode === "nowcast";
  $("u-banner").classList.toggle("hidden", !(nowcast && U.calibration));
  if (nowcast && U.calibration) $("u-banner").textContent = U.calibration.banner;
  if (!d) {
    status.className = "status l-none";
    $("u-status-label").textContent = "Press Play";
    $("u-line").textContent = "";
    $("u-sentence").textContent = nowcast ? "Choose one of the three real events and press Play. The model re-estimates every 5 minutes of the real storm." : "Choose a scenario and press Play. The system re-assesses every simulated minute.";
    setConf(0, "—", "");
    $("u-todo").textContent = "—";
    $("u-happening").textContent = "—"; $("u-expected").textContent = "—";
    $("u-grid").innerHTML = ""; $("u-rumor").classList.add("hidden");
    $("u-log").innerHTML = '<li class="muted">Nothing yet.</li>';
  } else {
    const v = d.view;
    if (nowcast) {
      status.className = `status l-${v.level ?? "none"}`;
      $("u-status-label").textContent = v.headline;
      $("u-line").textContent = "";
    } else {
      status.className = `status ${RULES_COLOR[v.status]}`;
      $("u-status-label").textContent = v.label.toUpperCase();
      $("u-line").textContent = v.line;
    }
    $("u-sentence").textContent = v.sentence;
    setConf(v.confidence.bar, v.confidence.word, v.confidence.note);
    $("u-todo").textContent = v.what_to_do;
    $("u-happening").textContent = v.happening;
    $("u-expected").textContent = v.expected;
    renderGrid(v);
    const r = $("u-rumor");
    r.classList.toggle("hidden", !(v.rumor));
    if (v.rumor) r.innerHTML = `<h2>Possible rumor</h2><p>${esc(v.rumor)}</p>`;
    const shown = U.log.filter((e) => e.i <= U.idx);
    $("u-log").innerHTML = shown.length ? shown.map((e) => `<li>${esc(e.text)}</li>`).reverse().join("") : '<li class="muted">Nothing yet.</li>';
  }
  drawThreat();
  // scrubber and clock
  const sc = $("u-scrub");
  sc.max = String(Math.max(0, U.ticks.length - 1));
  sc.value = String(Math.max(0, U.idx));
  sc.disabled = U.ticks.length < 2;
  $("u-live").classList.toggle("hidden", U.follow || !U.ticks.length || U.idx === U.ticks.length - 1);
  $("u-clock").textContent = d ? (nowcast ? `${d.local.slice(0, 10)} ${d.time}` : `minute ${d.minute} of ${U.total}`) + `  (${d.i + 1}/${U.total || U.ticks.length})` : "—";
  $("u-desc").textContent = describe();
  buttonsU();
  if (U.view === "technical" && nowcast) renderNowcastTech();
}

function setConf(bar, word, note) {
  const i = $("u-bar");
  i.style.width = `${Math.round(100 * bar)}%`;
  i.className = word === "None" ? "none" : word === "Low" ? "low" : "";
  $("u-conf-word").textContent = word;
  $("u-conf-note").textContent = note;
  $("layer1").querySelector(".confbar").setAttribute("aria-label", `Confidence ${word}`);
}

function renderGrid(v) {
  const g = $("u-grid");
  if (U.mode === "rules") {
    $("u-grid-title").textContent = "Zones";
    g.innerHTML = v.zones.map((z) => `<div class="zt s${z.severity}${z.expected ? " expected" : ""}"><b>${esc(z.name)}</b><span>${SEV_WORD[z.severity]}${z.expected ? " · expected next" : ""}</span></div>`).join("");
    $("u-grid-note").textContent = "Colour shows how much strong evidence arrived in the last 10 minutes. A dashed outline means the system expects the next stage there.";
  } else {
    $("u-grid-title").textContent = "The two forecasts (citywide)";
    g.innerHTML = v.targets.map((t) => `<div class="zt target s${t.level === "High" ? 3 : t.level === "Elevated" ? 2 : t.level === "Low" ? 1 : 0}"><b>${esc(t.name)}</b><span>${t.shown ? `${t.level}: ${pct(t.probability, 0)} chance in the next hour` : "No forecast: not enough reliable data"}</span></div>`).join("");
    $("u-grid-note").textContent = "This model forecasts the whole city, not neighbourhoods. The percentage is calibrated: about that share of such forecasts came true.";
  }
}

function drawThreat() {
  const canvas = $("u-threat");
  if (!canvas.clientWidth) return;
  const { c, w, h } = ctx2d(canvas);
  c.clearRect(0, 0, w, h);
  const names = LEVEL_NAMES[U.mode];
  const pad = { l: 64, r: 8, t: 8, b: 20 };
  const W = w - pad.l - pad.r, H = h - pad.t - pad.b;
  const n = Math.max(U.total, U.ticks.length, 2);
  const X = (i) => pad.l + (i / (n - 1)) * W;
  const Y = (lv) => pad.t + (1 - lv / (names.length - 1)) * H;
  c.font = "11px " + css("--mono"); c.fillStyle = css("--muted"); c.strokeStyle = css("--line"); c.lineWidth = 1;
  names.forEach((nm, lv) => { c.beginPath(); c.moveTo(pad.l, Y(lv)); c.lineTo(w - pad.r, Y(lv)); c.stroke(); c.fillText(nm, 4, Y(lv) + 4); });
  const shownTo = Math.max(0, U.idx);
  // hidden-forecast stretches in nowcast mode
  if (U.mode === "nowcast") {
    c.fillStyle = css("--panel-2");
    let start = -1;
    for (let i = 0; i <= shownTo + 1; i++) {
      const hid = i <= shownTo && U.ticks[i] && U.ticks[i].view.threat === null;
      if (hid && start < 0) start = i;
      if (!hid && start >= 0) { c.fillRect(X(start), pad.t, X(i - 1) - X(start) + 2, H); start = -1; }
    }
    c.fillStyle = css("--muted");
    if (U.ticks.some((t, i) => i <= shownTo && t.view.threat === null)) c.fillText("grey = no forecast shown", pad.l + 6, pad.t + 12);
  }
  c.strokeStyle = css("--accent"); c.lineWidth = 2.5; c.beginPath();
  let pen = false;
  for (let i = 0; i <= shownTo && U.ticks[i]; i++) {
    const lv = U.mode === "rules" ? U.ticks[i].view.threat : U.ticks[i].view.threat;
    if (lv === null) { pen = false; continue; }
    if (!pen) { c.moveTo(X(i), Y(lv)); pen = true; } else { c.lineTo(X(i), Y(lv)); }
  }
  c.stroke();
  if (U.idx >= 0) { c.strokeStyle = css("--muted"); c.setLineDash([3, 3]); c.beginPath(); c.moveTo(X(U.idx), pad.t); c.lineTo(X(U.idx), pad.t + H); c.stroke(); c.setLineDash([]); }
}

function describe() {
  if (U.mode === "nowcast") {
    const e = U.events.find((x) => x.id === U.pick);
    return e ? `${e.title}. ${e.note} Replayed from real data, ${e.ticks} five-minute steps.` : "";
  }
  const sc = U.scenarios.find((s) => s.id === U.pick);
  return sc ? `${sc.label}: a simulated crisis (the engine is shown the sensor and report streams only, never the answer).` : ""; // the technical view has the full scenario text, which quotes probabilities
}

function buttonsU() {
  const live = !!U.es;
  $("u-play").disabled = live && !U.paused;
  $("u-pause").disabled = !live || U.paused;
  $("u-step").disabled = live && !U.paused;
  for (const b of document.querySelectorAll("#mode-switch button")) b.classList.toggle("on", b.dataset.m === U.mode);
  for (const b of document.querySelectorAll("#view-switch button")) b.classList.toggle("on", b.dataset.v === U.view);
  $("layer2").classList.toggle("hidden", !U.more);
  $("u-more").textContent = U.more ? "Hide detail ▴" : "Show more detail ▾";
}

// ---- technical view of the nowcast mode ----
function renderNowcastTech() {
  const root = $("nowcast-tech");
  const d = cur();
  const cal = U.calibration;
  const f = (x, k = 3) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(k));
  const ci = (a) => (a ? `[${f(a[0])}, ${f(a[1])}]` : "");
  let html = `<div class="card notice">${esc(cal ? cal.banner : "")}</div>`;
  if (d) {
    html += `<div class="card"><h2>This tick: ${esc(d.local)}</h2><div class="scroll"><table>
      <tr><th>forecast</th><th>model score</th><th>calibrated, fixed</th><th>calibrated, rolling (not used)</th><th>shown</th><th>confidence gate</th><th>recent ECE / checks / events</th><th>what really happened next hour</th></tr>` +
      Object.entries(d.tech.targets).map(([k, t]) => `<tr><td>${k === "311" ? "flood-report surge" : "road slowdowns"}</td><td class="num">${f(t.raw)}</td><td class="num">${f(t.fixed)}</td><td class="num">${f(t.rolling)}</td><td class="num">${t.gate.show ? f(t.used) : "hidden"}</td><td>${esc(t.gate.reason)}: ${esc(t.gate.detail)}</td><td class="num">${t.recent ? `${t.recent.ece === null ? "—" : f(t.recent.ece)} / ${t.recent.n} / ${t.recent.positives}` : "—"}</td><td>${t.hindsight === null ? "no data" : t.hindsight ? "yes" : "no"}</td></tr>`).join("") + `</table></div></div>`;
    html += `<div class="card"><h2>Inputs at this tick</h2><div class="scroll"><table><tr>${Object.keys(d.tech.features).map((k) => `<th>${esc(k)}</th>`).join("")}</tr><tr>${Object.values(d.tech.features).map((x) => `<td class="num">${f(x, 2)}</td>`).join("")}</tr></table></div></div>`;
  }
  if (cal) {
    for (const [k, t] of Object.entries(cal.targets)) {
      const m = t.test, fr = t.fixed_vs_rolling;
      html += `<div class="card"><h2>${esc(t.name)}: the ${esc(t.model)} model on the 2025 to 2026 test years</h2>
        <p>${m.ticks} ticks, ${m.events} rain events, positive rate ${pct(m.positive_rate, 1)}. <span class="tip-label">Brier</span> ${f(m.brier)} · <span class="tip-label">ECE</span> ${f(m.ece)} · <span class="tip-label">AUC</span> ${f(m.auc, 2)}</p>
        <h2>Reliability table (test years)</h2><div class="scroll"><table><tr><th>stated chance</th>${t.reliability.filter((r) => r.n).map((r) => `<th>${r.bin}</th>`).join("")}</tr>
          <tr><td>checks</td>${t.reliability.filter((r) => r.n).map((r) => `<td class="num">${r.n}</td>`).join("")}</tr>
          <tr><td>average stated</td>${t.reliability.filter((r) => r.n).map((r) => `<td class="num">${f(r.mean_pred, 2)}</td>`).join("")}</tr>
          <tr><td>really happened</td>${t.reliability.filter((r) => r.n).map((r) => `<td class="num">${f(r.observed, 2)}</td>`).join("")}</tr></table></div>
        <h2>Calibration: fixed or rolling?</h2><div class="scroll"><table><tr><th></th><th>Brier</th><th>ECE</th></tr>
          <tr><td>fixed (fitted on 2024)</td><td class="num">${f(fr.brier.fixed, 4)} ${ci(fr.brier.fixed_ci)}</td><td class="num">${f(fr.ece.fixed)} ${ci(fr.ece.fixed_ci)}</td></tr>
          <tr><td>rolling (last 6 months)</td><td class="num">${f(fr.brier.rolling, 4)} ${ci(fr.brier.rolling_ci)}</td><td class="num">${f(fr.ece.rolling)} ${ci(fr.ece.rolling_ci)}</td></tr>
          <tr><td>difference, rolling minus fixed</td><td class="num">${f(fr.brier.diff, 4)} ${ci(fr.brier.diff_ci)}</td><td class="num">${f(fr.ece.diff)} ${ci(fr.ece.diff_ci)}</td></tr></table></div>
        <p class="muted small">Rolling calibration is ${t.adopt_rolling ? "" : "<b>not</b> "}used here: it is adopted only if the ECE difference interval excludes zero.</p></div>`;
    }
    html += `<div class="card"><h2>The confidence gate</h2><p>A number is shown only if the inputs exist and lie inside the training range, there are at least ${cal.gate.min_ticks} recent checks with at least ${cal.gate.min_positives} real events in the last ${cal.gate.recent_months} months, and the recent <span class="tip-label">expected calibration error</span> is at most ${cal.gate.ece_limit}. Otherwise: "Not enough reliable data to forecast".</p></div>`;
  }
  root.innerHTML = html;
}

// ---- wiring ----
async function loadLists() {
  try {
    U.scenarios = (await (await fetch("/api/scenarios")).json()).filter((s) => s.mode === "single");
    const nc = await (await fetch("/api/nowcast/events")).json();
    U.events = nc.events; U.calibration = nc.calibration;
  } catch { $("u-desc").textContent = "Could not reach the server. Run: npm run dev"; }
}
function fillPicker() {
  const sel = $("u-pick");
  if (U.mode === "rules") {
    sel.innerHTML = U.scenarios.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("");
    U.pick = U.scenarios.find((s) => s.id === "cascade")?.id ?? U.scenarios[0]?.id;
  } else {
    sel.innerHTML = U.events.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join("");
    U.pick = U.events[0]?.id;
  }
  sel.value = U.pick;
}
function setModeU(m) {
  if (m === U.mode) return;
  U.mode = m;
  document.body.dataset.mode = m;
  resetU(); fillPicker(); renderU();
}
function setViewU(v) {
  U.view = v;
  document.body.dataset.view = v;
  if (v === "technical" && U.mode === "nowcast") renderNowcastTech();
  renderU();
  if (v === "technical" && U.mode === "rules") window.dispatchEvent(new Event("resize")); // the technical canvases were hidden: redraw at their real size
}

async function initU() {
  watchTips();
  await loadLists();
  fillPicker();
  $("u-pick").addEventListener("change", (e) => { U.pick = e.target.value; resetU(); });
  $("u-play").addEventListener("click", playU);
  $("u-pause").addEventListener("click", pauseU);
  $("u-step").addEventListener("click", stepU);
  $("u-reset").addEventListener("click", resetU);
  for (const b of document.querySelectorAll("#u-speeds button")) b.addEventListener("click", () => speedU(Number(b.dataset.s)));
  for (const b of document.querySelectorAll("#mode-switch button")) b.addEventListener("click", () => setModeU(b.dataset.m));
  for (const b of document.querySelectorAll("#view-switch button")) b.addEventListener("click", () => setViewU(b.dataset.v));
  $("u-more").addEventListener("click", () => { U.more = !U.more; renderU(); });
  $("u-scrub").addEventListener("input", (e) => { U.idx = Number(e.target.value); U.follow = U.idx === U.ticks.length - 1 && !U.finished ? true : false; renderU(); });
  $("u-live").addEventListener("click", () => { U.follow = true; U.idx = U.ticks.length - 1; renderU(); });
  document.addEventListener("keydown", (e) => {
    if (document.body.dataset.view !== "simple") return;
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    if (e.key === " ") { e.preventDefault(); U.es && !U.paused ? pauseU() : playU(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stepU(); }
    else if (e.key === "r" || e.key === "R") resetU();
  });
  window.addEventListener("resize", () => drawThreat());
  renderU();
}
initU();
