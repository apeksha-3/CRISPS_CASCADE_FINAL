// server/nowcast.ts
// ML nowcast mode: replay three real events tick by tick through the exported Phase 9 models, with the confidence gate.
// The models (ml/models/*.json) are used exactly as exported; nothing here retrains or refits them. The calibration is the
// fixed Phase 9 Platt scaling unless ml/recalibration.json says the rolling one was adopted (it was not: see the Phase 10 report).
//
// Everything the dashboard shows comes from here as plain fields (view) or as numbers for the technical view (tech).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confidenceBar, confidenceGate, confidenceWord, GATE, GATE_MESSAGE, type GateResult, type Recent } from "../ml/gate";
import { gbtScore, logisticScore, type NowcastFile } from "../ml/nowcast";
import { BANNER, headline, levelOf, type Level, LEVELS, naturalFrequency, reliabilityNote, sentence, TARGET_NAME, type TargetKey, whatToDo } from "../ml/text";

const root = process.cwd();
const json = <T>(p: string) => JSON.parse(readFileSync(join(root, p), "utf8")) as T;

export const DASH_MODEL: Record<TargetKey, "gbt" | "logistic"> = { "311": "gbt", traffic: "logistic" };

interface Recal {
  dashboard_model: Record<string, string>;
  targets: Record<string, {
    adopt_rolling: boolean;
    rolling: Record<string, { a: number; b: number }>;
    recent: Record<string, Recent>;
    training_range: Record<string, [number, number]>;
    models: Record<string, { brier: { fixed: number; fixed_ci: number[]; rolling: number; rolling_ci: number[]; diff: number; diff_ci: number[] }; ece: { fixed: number; fixed_ci: number[]; rolling: number; rolling_ci: number[]; diff: number; diff_ci: number[] } }>;
    test_metrics: { model: string; brier: number; ece: number; auc: number; positive_rate: number; ticks: number; events: number };
    reliability_test: { bin: string; n: number; mean_pred: number | null; observed: number | null }[];
  }>;
}

export interface ReplayEvent {
  id: string;
  title: string;
  note: string;
  tick_event: string;
  split: string;
  ticks: { local: string; f: number[]; y311: number; ytraffic: number | null }[];
}

export interface Runtime {
  files: Record<TargetKey, NowcastFile>;
  recal: Recal;
  events: ReplayEvent[];
  features: string[];
}

let cached: Runtime | undefined;
export function runtime(): Runtime {
  if (cached) return cached;
  const replay = json<{ features: string[]; events: ReplayEvent[] }>("ml/replay/events.json");
  cached = { files: { "311": json<NowcastFile>("ml/models/nowcast-311.json"), traffic: json<NowcastFile>("ml/models/nowcast-traffic.json") }, recal: json<Recal>("ml/recalibration.json"), events: replay.events, features: replay.features };
  return cached;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

// calibrated probability for one target at one tick: the fixed Platt numbers, or the month's rolling ones if that was adopted
export function calibrated(rt: Runtime, target: TargetKey, f: number[], month: string): { p: number; raw: number; fixed: number; rolling: number | null } {
  const file = rt.files[target];
  const m = DASH_MODEL[target];
  const raw = m === "gbt" ? gbtScore(file.models.gbt, f) : logisticScore(file.models.logistic, f);
  const fixedParams = m === "gbt" ? file.models.gbt : file.models.logistic;
  const fixed = sigmoid(fixedParams.platt_a * raw + fixedParams.platt_b);
  const r = rt.recal.targets[target].rolling[month];
  const rolling = r ? sigmoid(r.a * raw + r.b) : null;
  const p = rt.recal.targets[target].adopt_rolling && rolling !== null ? rolling : fixed;
  return { p, raw, fixed, rolling };
}

export interface NowcastTick {
  index: number;
  total: number;
  local: string;
  time: string; // "21:30"
  view: {
    headline: string; // the big status
    level: Level | null; // null = the gate hid the forecast
    sentence: string;
    what_to_do: string;
    confidence: { bar: number; word: string; note: string };
    banner: string;
    happening: string;
    expected: string;
    threat: number | null; // 0 Low, 1 Elevated, 2 High; null when hidden
    targets: { key: TargetKey; name: string; shown: boolean; probability: number | null; level: Level | null; bar: number }[];
  };
  tech: {
    targets: Record<string, { raw: number; fixed: number; rolling: number | null; used: number; gate: GateResult; recent: Recent | null; hindsight: number | null }>;
    features: Record<string, number>;
  };
}

export function nowcastTick(rt: Runtime, ev: ReplayEvent, i: number): NowcastTick {
  const t = ev.ticks[i];
  const month = t.local.slice(0, 7);
  const feat = Object.fromEntries(rt.features.map((n, k) => [n, t.f[k]])) as Record<string, number>;
  const targets: NowcastTick["view"]["targets"] = [];
  const techT: NowcastTick["tech"]["targets"] = {};
  const shown: { target: TargetKey; p: number }[] = [];
  const hidden: TargetKey[] = [];
  let bar = 1;
  let worstEce: number | null = null;
  let checks = 0;
  for (const key of ["traffic", "311"] as TargetKey[]) {
    const cal = calibrated(rt, key, t.f, month);
    const info = rt.recal.targets[key];
    const recent = info.recent[month];
    const gate = confidenceGate({ recent, features: feat, range: info.training_range, needsDot: key === "traffic" });
    const b = gate.show ? confidenceBar(recent!.ece) : 0;
    targets.push({ key, name: TARGET_NAME[key], shown: gate.show, probability: gate.show ? cal.p : null, level: gate.show ? levelOf(cal.p) : null, bar: b });
    techT[key] = { raw: cal.raw, fixed: cal.fixed, rolling: cal.rolling, used: cal.p, gate, recent: recent ?? null, hindsight: key === "311" ? t.y311 : t.ytraffic };
    if (gate.show) {
      shown.push({ target: key, p: cal.p });
      bar = Math.min(bar, b);
      if (worstEce === null || recent!.ece! > worstEce) { worstEce = recent!.ece!; checks = recent!.n; }
    } else hidden.push(key);
  }
  const level: Level | null = shown.length ? LEVELS[Math.max(...shown.map((s) => LEVELS.indexOf(levelOf(s.p))))] : null;
  const normal = Math.max(0, (feat.c311_30 + 1) / feat.r311 - 1);
  const happening =
    `Rain: ${feat.rate_now.toFixed(1)} mm/h now, ${feat.acc60.toFixed(1)} mm in the last hour. ` +
    `${Math.round(feat.c311_30)} flood and drainage reports to 311 in the last 30 minutes (normal for this hour: about ${normal.toFixed(0)}). ` +
    (feat.dot_ok === 1 ? `${Math.round(100 * feat.dot_frac)}% of monitored roads were running slow in the last full hour.` : "The road-speed feed has no data for the last hour.");
  const expected = shown.length ? "Next hour: " + shown.map((s) => `${naturalFrequency(s.p)} chance of ${s.target === "traffic" ? "road slowdowns" : "a flood-report surge"}`).join("; ") + "." : `${GATE_MESSAGE}.`;
  return {
    index: i,
    total: ev.ticks.length,
    local: t.local,
    time: t.local.slice(11, 16),
    view: {
      headline: level ? headline(level) : GATE_MESSAGE,
      level,
      sentence: sentence(shown, hidden),
      what_to_do: whatToDo(level),
      confidence: { bar: shown.length ? bar : 0, word: shown.length ? confidenceWord(bar) : "None", note: shown.length ? reliabilityNote(worstEce, checks) : `${GATE_MESSAGE}: the checks behind it did not pass (the technical view says which).` },
      banner: BANNER,
      happening,
      expected,
      threat: level ? LEVELS.indexOf(level) : null,
      targets,
    },
    tech: { targets: techT, features: feat },
  };
}

export function eventSummary(rt: Runtime, ev: ReplayEvent) {
  const share = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  return { id: ev.id, title: ev.title, note: ev.note, ticks: ev.ticks.length, first: ev.ticks[0].local, last: ev.ticks[ev.ticks.length - 1].local, split: ev.split, hindsight: { flood_report_surge_share: share(ev.ticks.map((x) => x.y311)), road_slowdown_share: share(ev.ticks.map((x) => x.ytraffic)) } };
}

// what the technical view of the nowcast mode shows besides the tick: the Phase 9 test scores, the reliability table and the fixed-versus-rolling table
export function calibrationReport(rt: Runtime) {
  return {
    banner: BANNER,
    gate: GATE,
    targets: Object.fromEntries((["311", "traffic"] as TargetKey[]).map((k) => {
      const t = rt.recal.targets[k];
      const m = DASH_MODEL[k];
      return [k, { name: TARGET_NAME[k], model: m, adopt_rolling: t.adopt_rolling, test: t.test_metrics, reliability: t.reliability_test, fixed_vs_rolling: t.models[m] }];
    })),
  };
}
