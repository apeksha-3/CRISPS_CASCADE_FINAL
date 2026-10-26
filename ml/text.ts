// ml/text.ts
// Every word the dashboard shows in ML nowcast mode, in one place so a test can check it. The nowcast predicts road slowdowns and
// flood-report surges in the next hour for the whole city: nothing else. The copy never uses the engine's word for a multi-stage
// crisis, because this model does not detect one (a test scans every string).

import { GATE, GATE_MESSAGE } from "./gate";

export type Level = "Low" | "Elevated" | "High";
export const LEVELS: Level[] = ["Low", "Elevated", "High"];
export const BANDS = { elevated: 0.2, high: 0.5 }; // calibrated probability at which the level rises

export const levelOf = (p: number): Level => (p >= BANDS.high ? "High" : p >= BANDS.elevated ? "Elevated" : "Low");

export const BANNER =
  "This model predicts road slowdowns and flood-report surges in the next hour, for New York City as a whole. " +
  "It does not predict flood depth, damage or injuries, and it does not forecast by neighbourhood. " +
  "It learned from rain events in 2019 to 2023, was tuned on 2024 and checked on 2025 to 2026. Three real events are replayed here.";

export const TARGET_NAME = { "311": "flood-report surge", traffic: "road slowdowns" } as const;
export type TargetKey = keyof typeof TARGET_NAME;

export const headline = (level: Level) => `${level} chance of road slowdowns and flood reports in the next hour`;
export const NO_FORECAST = GATE_MESSAGE;

export function naturalFrequency(p: number): string {
  const k = Math.round(p * 10);
  if (k <= 0) return "less than 1 in 10";
  if (k >= 10) return "more than 9 in 10";
  return `about ${k} in 10`;
}

export function sentence(shown: { target: TargetKey; p: number }[], hidden: TargetKey[]): string {
  if (shown.length === 0) return `${NO_FORECAST}. The model's recent record or its inputs are not good enough to put a number on the next hour.`;
  const parts = shown.map((s) => `${naturalFrequency(s.p)} chance of ${s.target === "traffic" ? "road slowdowns" : "a flood-report surge"}`);
  const tail = hidden.length ? ` The ${hidden.map((h) => TARGET_NAME[h]).join(" and ")} forecast is not shown: not enough reliable data.` : "";
  return `In the next hour: ${parts.join(" and ")}.${tail}`;
}

export const whatToDo = (level: Level | null): string =>
  level === null
    ? "Use your own judgement and the live feeds; this forecast is not available right now."
    : level === "Low"
      ? "Keep normal monitoring."
      : level === "Elevated"
        ? "Check that road crews and drainage teams are ready, and watch the 311 reports and road speeds."
        : "Alert road and drainage crews now and prepare to warn the public about flooded roads.";

export function reliabilityNote(ece: number | null, n: number): string {
  if (ece === null) return "There are not enough recent checks to measure how reliable the numbers are.";
  const pts = Math.round(100 * ece);
  return `Over the last ${GATE.recent_months} months its probabilities were off by about ${pts} percentage point${pts === 1 ? "" : "s"} on average (${n} checks). ${pts <= 3 ? "That is good." : pts <= 6 ? "That is fair." : "Treat the numbers as rough."}`;
}

// all fixed strings, for the test
export const ALL_STATIC_TEXT = [BANNER, NO_FORECAST, ...LEVELS.map(headline), ...LEVELS.map(whatToDo), whatToDo(null), ...Object.values(TARGET_NAME)];
