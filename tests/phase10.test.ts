// tests/phase10.test.ts
// Phase 10: the confidence gate (both branches), the nowcast replay, the plain-language views, the rolling-recalibration decision.
// Needs the simulator episodes built (npm run sim -- --build) like the other server tests. Everything else is committed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { confidenceBar, confidenceGate, confidenceWord, GATE, GATE_MESSAGE, type GateInput } from "../ml/gate";
import { predict } from "../ml/nowcast";
import { ALL_STATIC_TEXT, BANNER, levelOf, naturalFrequency, reliabilityNote, sentence } from "../ml/text";
import { createApp } from "../server/index";
import { calibrated, DASH_MODEL, nowcastTick, runtime } from "../server/nowcast";
import { zoneSeverity } from "../server/simple";

const root = join(__dirname, "..");
let server: Server;
let base = "";
beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

async function sse(path: string): Promise<{ event: string; data: any }[]> {
  const text = await (await fetch(base + path)).text();
  return text.split("\n\n").filter((b) => b.trim()).map((b) => ({ event: /^event: (.*)$/m.exec(b)![1], data: JSON.parse(/^data: (.*)$/m.exec(b)![1]) }));
}

// ---------------------------------------------------------------- the confidence gate
const range = { rate_now: [0, 100], c311_30: [0, 400], dot_frac: [0, 1] } as Record<string, [number, number]>;
const ok = (over: Partial<GateInput> = {}): GateInput => ({
  recent: { n: 500, positives: 60, ece: 0.05 },
  features: { rate_now: 20, c311_30: 40, dot_frac: 0.1, dot_ok: 1 },
  range,
  needsDot: true,
  ...over,
});

describe("confidence gate", () => {
  it("SHOWS a number when inputs exist, are in range, the recent record is long enough and honest", () => {
    const g = confidenceGate(ok());
    expect(g.show).toBe(true);
    expect(g.reason).toBe("ok");
  });
  it("the calibration limit is inclusive: exactly 0.10 still shows, just above does not", () => {
    expect(confidenceGate(ok({ recent: { n: 500, positives: 60, ece: GATE.ece_limit } })).show).toBe(true);
    const g = confidenceGate(ok({ recent: { n: 500, positives: 60, ece: GATE.ece_limit + 0.001 } }));
    expect(g.show).toBe(false);
    expect(g.reason).toBe("calibration");
  });
  it("HIDES when the inputs are outside the training range (either side), naming the input", () => {
    for (const x of [-1, 101]) {
      const g = confidenceGate(ok({ features: { rate_now: x, c311_30: 40, dot_frac: 0.1, dot_ok: 1 } }));
      expect(g.show).toBe(false);
      expect(g.reason).toBe("out_of_range");
      expect(g.detail).toContain("rate_now");
    }
    expect(confidenceGate(ok({ features: { rate_now: 100, c311_30: 0, dot_frac: 1, dot_ok: 1 } })).show).toBe(true); // the edges of the range are inside it
  });
  it("HIDES when an input is missing: the road-speed feed for the traffic forecast, or any feature", () => {
    expect(confidenceGate(ok({ features: { rate_now: 20, c311_30: 40, dot_frac: 0, dot_ok: 0 } })).reason).toBe("missing_input");
    expect(confidenceGate(ok({ features: { rate_now: 20, c311_30: 40, dot_frac: 0, dot_ok: 0 }, needsDot: false })).show).toBe(true); // the 311 forecast does not need DOT
    expect(confidenceGate(ok({ features: { rate_now: Number.NaN, c311_30: 40, dot_frac: 0.1, dot_ok: 1 } })).reason).toBe("missing_input");
    expect(confidenceGate(ok({ features: { c311_30: 40, dot_frac: 0.1, dot_ok: 1 } })).reason).toBe("missing_input");
  });
  it("HIDES when there is too little recent evidence to check the calibration", () => {
    for (const recent of [undefined, { n: 299, positives: 60, ece: 0.02 }, { n: 500, positives: 19, ece: 0.02 }, { n: 500, positives: 60, ece: null }]) {
      const g = confidenceGate(ok({ recent }));
      expect(g.show).toBe(false);
      expect(g.reason).toBe("too_few_recent");
    }
  });
  it("the confidence bar comes from calibration error only: full at 0, empty at the scale, never below 0 or above 1", () => {
    expect(confidenceBar(0)).toBe(1);
    expect(confidenceBar(GATE.bar_scale)).toBe(0);
    expect(confidenceBar(0.5)).toBe(0);
    expect(confidenceBar(-1)).toBe(1);
    expect(confidenceBar(null)).toBe(0);
    expect(confidenceBar(0.03)).toBeGreaterThan(confidenceBar(0.08));
    // a probability shown by the gate always has a visible bar: the gate limit sits above the empty end
    expect(confidenceBar(GATE.ece_limit)).toBeGreaterThan(0.3);
    expect(confidenceWord(1)).toBe("High");
    expect(confidenceWord(0.5)).toBe("Medium");
    expect(confidenceWord(0.1)).toBe("Low");
  });
});

// ---------------------------------------------------------------- the words
describe("nowcast wording", () => {
  const rt = runtime();
  const allText = (): string[] => {
    const out = [...ALL_STATIC_TEXT];
    for (const ev of rt.events) for (let i = 0; i < ev.ticks.length; i += 3) {
      const t = nowcastTick(rt, ev, i);
      out.push(t.view.headline, t.view.sentence, t.view.what_to_do, t.view.confidence.note, t.view.confidence.word, t.view.happening, t.view.expected, t.view.banner, ...t.view.targets.map((x) => x.name));
    }
    return out;
  };
  it("says what it predicts, in the required words, and never uses the engine's word for a multi-stage crisis", () => {
    expect(BANNER).toContain("road slowdowns and flood-report surges");
    for (const s of allText()) expect(s.toLowerCase(), s).not.toContain("cascade");
  });
  it("the hidden-forecast message is exactly the specified sentence and carries no number", () => {
    expect(GATE_MESSAGE).toBe("Not enough reliable data to forecast");
    expect(sentence([], ["311", "traffic"])).toContain(GATE_MESSAGE);
    expect(sentence([], ["311", "traffic"])).not.toMatch(/\d in 10/);
  });
  it("levels and plain probabilities", () => {
    expect([0.05, 0.2, 0.49, 0.5, 0.99].map(levelOf)).toEqual(["Low", "Elevated", "Elevated", "High", "High"]);
    expect(naturalFrequency(0.31)).toBe("about 3 in 10");
    expect(naturalFrequency(0.02)).toBe("less than 1 in 10");
    expect(naturalFrequency(0.99)).toBe("more than 9 in 10");
    expect(reliabilityNote(null, 0)).toContain("not enough");
  });
});

// ---------------------------------------------------------------- the replay of the three real events
describe("nowcast replay", () => {
  const rt = runtime();
  it("has the three events with their tick counts", () => {
    expect(rt.events.map((e) => [e.id, e.ticks.length])).toEqual([["ida-2021", 98], ["flood-2023", 217], ["flood-2025", 36]]);
  });
  it("the calibrated probability is the Phase 9 exported model's, tick by tick (the models are used as exported)", () => {
    const ev = rt.events[0];
    for (const i of [0, 40, 80]) {
      const t = ev.ticks[i];
      const month = t.local.slice(0, 7);
      expect(calibrated(rt, "311", t.f, month).fixed).toBeCloseTo(predict(rt.files["311"], DASH_MODEL["311"], t.f), 12);
      expect(calibrated(rt, "traffic", t.f, month).fixed).toBeCloseTo(predict(rt.files.traffic, DASH_MODEL.traffic, t.f), 12);
    }
  });
  it("rolling calibration is NOT used: the adoption flag follows the rule (ECE improvement with an interval that excludes zero)", () => {
    for (const k of ["311", "traffic"] as const) {
      const t = rt.recal.targets[k];
      const m = t.models[DASH_MODEL[k]];
      expect(t.adopt_rolling).toBe(m.ece.diff_ci[1] < 0);
    }
    expect(rt.recal.targets["311"].adopt_rolling).toBe(false);
    expect(rt.recal.targets.traffic.adopt_rolling).toBe(false);
  });
  it("is deterministic and every shown probability is a probability; a hidden forecast shows no number anywhere in the view", () => {
    for (const ev of rt.events) for (let i = 0; i < ev.ticks.length; i++) {
      const a = nowcastTick(rt, ev, i);
      expect(JSON.stringify(nowcastTick(rt, ev, i))).toBe(JSON.stringify(a));
      for (const t of a.view.targets) {
        if (t.shown) {
          expect(t.probability).toBeGreaterThanOrEqual(0);
          expect(t.probability).toBeLessThanOrEqual(1);
        } else {
          expect(t.probability).toBeNull();
          expect(t.level).toBeNull();
        }
      }
      if (a.view.level === null) {
        expect(a.view.headline).toBe(GATE_MESSAGE);
        expect(a.view.threat).toBeNull();
        expect(a.view.sentence).not.toMatch(/\d in 10/);
        expect(a.view.confidence.word).toBe("None");
      }
    }
  });
  it("the gate branches both occur on the real events: Ida and 14 Jul 2025 are forecast, 29 Sep 2023 is not", () => {
    const shown = (id: string) => { const ev = rt.events.find((e) => e.id === id)!; return ev.ticks.map((_, i) => nowcastTick(rt, ev, i).view.level !== null); };
    expect(shown("ida-2021").every(Boolean)).toBe(true);
    expect(shown("flood-2025").every(Boolean)).toBe(true);
    expect(shown("flood-2023").some(Boolean)).toBe(false);
    const why = nowcastTick(rt, rt.events[1], 10).tech.targets;
    expect(["calibration", "too_few_recent"]).toContain(why["311"].gate.reason);
  });
  it("the stream carries the same ticks and the word cascade appears nowhere in it", async () => {
    const evs = await sse("/api/nowcast/replay?event=flood-2025&speed=0");
    expect(evs[0].event).toBe("episode-start");
    expect(evs.filter((e) => e.event === "tick")).toHaveLength(36);
    expect(evs[evs.length - 1].event).toBe("episode-end");
    expect(JSON.stringify(evs).toLowerCase()).not.toContain("cascade");
    expect(evs.filter((e) => e.event === "tick")[5].data.view.headline).toMatch(/chance of road slowdowns and flood reports in the next hour/);
  });
  it("an unknown event is a 404", async () => {
    expect((await fetch(`${base}/api/nowcast/replay?event=nope`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------- rolling recalibration experiment
describe("recalibration file", () => {
  const recal = JSON.parse(readFileSync(join(root, "ml", "recalibration.json"), "utf8"));
  it("rolling calibrators come only from windows with enough data, and the models themselves were not refitted", () => {
    for (const t of ["311", "traffic"]) {
      for (const r of Object.values(recal.targets[t].rolling) as { n: number; positives: number }[]) {
        expect(r.n).toBeGreaterThanOrEqual(recal.limits.min_ticks);
        expect(r.positives).toBeGreaterThanOrEqual(recal.limits.min_class);
      }
    }
    const p9 = JSON.parse(readFileSync(join(root, "ml", "models", "nowcast-311.json"), "utf8"));
    expect(p9.models.gbt.platt_a).toBeTypeOf("number"); // the exported model is read as is; recalibrate.py never writes it
  });
});

// ---------------------------------------------------------------- the plain-language rules view
describe("rules engine, simple view", () => {
  it("zone severity levels", () => {
    expect([0, 0.5, 1.99, 2, 4.99, 5, 20].map(zoneSeverity)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });
  it("sends a plain view per tick and no probabilities, log-likelihoods or Brier scores", async () => {
    const evs = await sse("/api/simple/replay?split=test&episode=test-cascade-5139&speed=0");
    const ticks = evs.filter((e) => e.event === "tick");
    expect(ticks).toHaveLength(45);
    const text = JSON.stringify(ticks).toLowerCase();
    for (const bad of ["probabilities", "llr", "brier", "log_loss", "hypothesis_contributions", "expected_cost"]) expect(text).not.toContain(bad);
    const v = ticks[16].data.view;
    expect(["WATCH", "PREPARE", "ALERT", "ESCALATE"]).toContain(v.status);
    expect(v.sentence.length).toBeGreaterThan(10);
    expect(v.what_to_do.length).toBeGreaterThan(10);
    expect(v.confidence.bar).toBeGreaterThan(0);
    expect(v.zones).toHaveLength(10);
    // the real cascade reaches a high level (the same episode the engine tests use)
    expect(ticks.some((t) => ["ALERT", "ESCALATE"].includes(t.data.view.status))).toBe(true);
  });
  it("the rumor callout fires on the rumor wave and not on a plain cascade", async () => {
    const rumor = (await sse("/api/simple/replay?split=test&episode=test-rumor_wave-5250&speed=0")).filter((e) => e.event === "tick");
    expect(rumor.some((t) => typeof t.data.view.rumor === "string" && t.data.view.rumor.includes("tell the same story"))).toBe(true);
    const plain = (await sse("/api/simple/replay?split=test&episode=test-cascade-5139&speed=0")).filter((e) => e.event === "tick");
    expect(plain.every((t) => t.data.view.rumor === null)).toBe(true);
  });
  it("confidence is halved while the engine is degraded (the cutout demo)", async () => {
    const ticks = (await sse("/api/simple/replay?split=test&episode=test-cutout-5234&degraded_threshold=0.8&speed=0")).filter((e) => e.event === "tick").map((t) => t.data.view);
    const deg = ticks.filter((v) => v.degraded);
    const norm = ticks.filter((v) => !v.degraded);
    expect(deg.length).toBeGreaterThan(0);
    expect(norm.length).toBeGreaterThan(0);
    expect(deg[0].confidence.bar).toBeCloseTo(norm[0].confidence.bar / 2, 9);
    expect(deg[0].confidence.note).toContain("silent");
  });
});

// ---------------------------------------------------------------- the pages
describe("dashboard files", () => {
  const html = readFileSync(join(root, "dashboard", "index.html"), "utf8");
  const js = readFileSync(join(root, "dashboard", "simple.js"), "utf8");
  it("Layer 1 shows status, one sentence, a confidence bar and what to do, and none of the technical words", () => {
    const layer1 = html.slice(html.indexOf('id="layer1"'), html.indexOf('id="u-more"')).toLowerCase();
    for (const need of ["u-status", "u-sentence", "u-bar", "u-todo"]) expect(layer1).toContain(need);
    for (const bad of ["brier", "llr", "likelihood", "probabilit"]) expect(layer1).not.toContain(bad);
    expect(layer1).not.toMatch(/\bece\b/);
  });
  it("has the mode switch, the view toggle, the time scrubber, the alert log and a mobile layout", () => {
    expect(html).toContain("Rules engine (simulator)");
    expect(html).toContain("ML nowcast (real NYC)");
    expect(html).toContain('id="u-scrub"');
    expect(html).toContain('id="u-log"');
    expect(readFileSync(join(root, "dashboard", "user.css"), "utf8")).toContain("max-width: 640px");
  });
  it("every metric label has a plain one-line tooltip: Brier, false alarm rate, lead time, ECE (and log-loss, cost, flip-flops, AUC)", () => {
    for (const label of ["Brier ↓", "Log-loss ↓", "False alarms ↓", "Cost / tick ↓", "Lead time (min) ↑", "Flip-flops / ep ↓", "Forecast acc. ↑", "ECE", "AUC", "ALERT+"]) {
      const tip = /\[\/(.+?)\/i?, "([^"]+)"\]/g;
      let hit: string | undefined;
      for (const m of js.matchAll(tip)) if (new RegExp(m[1], "i").test(label)) { hit = m[2]; break; }
      expect(hit, label).toBeTruthy();
      expect(hit!.length).toBeLessThan(140); // one line
    }
  });
});
