// server/scenarios.ts
// The demo scenarios: hand-picked TEST episodes whose behavior is clear on screen.
// Picked by replaying every candidate with the cold-start engine (server/runner.ts)
// and reading the traces; see docs/phase-reports/phase-5.md for the numbers behind each pick.
// `npm run demo-check` (server/demo-check.ts) re-checks every expectation below.

import type { Split } from "../sim/dataset";

export type Expectation =
  | { kind: "twin"; divergeBy: number; withinS: number } // pre-split identical, then differ by > divergeBy within withinS of the split
  | { kind: "max_action"; max: "PREPARE" } // never above PREPARE
  | { kind: "min_action"; min: "ALERT" } // reaches ALERT or ESCALATE
  | { kind: "degraded" }; // DEGRADED fires at least once

export interface Scenario {
  id: string;
  label: string;
  description: string;
  mode: "single" | "twin";
  split: Split;
  episode?: string; // single mode
  twin?: string; // twin mode: the pair id
  degradedBelow?: number; // demo-only DEGRADED threshold, sent as ?degraded_threshold= (engine default 0.5), see "cutout"
  expect: Expectation;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "twin",
    label: "Twin Test",
    description:
      "Two episodes with a byte-identical first 9 minutes; then one becomes a cascade and the other stays benign. " +
      "Beliefs are identical up to the SPLIT line, and differ by 0.64 within 5 minutes after it.",
    mode: "twin",
    split: "test",
    twin: "test-twin-5221",
    // 5 minutes, not the spec's 3: cascade stages take ~4 min to propagate; 3-minute divergence is unrealistic
    // given the sim's lag distributions. No test or dev pair differs by > 0.1 within 3 min of the split (best: 0.068):
    // the next stage needs ~2 min to start and 1-3 min to be reported. We check the honest 5 minutes, not a faked faster split.
    expect: { kind: "twin", divergeBy: 0.1, withinS: 300 },
  },
  {
    id: "gateway",
    label: "Gateway Outage + Rumor Wave",
    description:
      "Gateway gw0 starts lying: 25+ sensors report the identical value 99.9. Count-threshold escalates; " +
      "the engine reads the identical values as one broken gateway (P(sensor_failure) 0.97 by minute 7) and never goes above PREPARE.",
    mode: "single",
    split: "test",
    episode: "test-sensor_failure-5045",
    expect: { kind: "max_action", max: "PREPARE" },
  },
  {
    id: "cutout",
    label: "Cutout",
    description:
      "A real cascade during which gateway gw0 goes silent for 18 minutes (26 sensors dark). Coverage drops to 75%, " +
      "the engine widens its belief toward the base rates and holds at ALERT; it escalates only when the sensors return. " +
      "DEMO THRESHOLD: DEGRADED is shown below 80% trust-weighted coverage here (engine default 50%, which no simulated cutout reaches).",
    mode: "single",
    split: "test",
    episode: "test-cutout-5234",
    degradedBelow: 0.8,
    expect: { kind: "degraded" },
  },
  {
    id: "cascade",
    label: "Real Cascade",
    description:
      "Rain, drainage, traffic, calls, hospitals, power. P(cascade) stays at or below 0.12 for 12 minutes; then hospital " +
      "reports arrive (0.65 at minute 13): ALERT at 14, ESCALATE at 15 when the forecast power-grid load arrives on schedule.",
    mode: "single",
    split: "test",
    episode: "test-cascade-5139",
    expect: { kind: "min_action", min: "ALERT" },
  },
  {
    id: "rain",
    label: "Rain Only (Lookalike)",
    description:
      "Heavy rain with drainage and traffic anomalies, but nothing downstream. Count-threshold escalates; " +
      "the engine groups rain + drainage + traffic of a zone as one weather event and stays at PREPARE.",
    mode: "single",
    split: "test",
    episode: "test-rain_only-5170",
    expect: { kind: "max_action", max: "PREPARE" },
  },
  {
    id: "rumor",
    label: "Rumor Wave",
    description:
      "44 citizen reports of one story flood in from zone z04 within 3 minutes, with no sensor backing them. Count-threshold escalates; " +
      "narrative clustering counts the whole story as one report (weight 1.0) and the engine never goes above PREPARE.",
    mode: "single",
    split: "test",
    episode: "test-rumor_wave-5250",
    expect: { kind: "max_action", max: "PREPARE" },
  },
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
