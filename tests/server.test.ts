// tests/server.test.ts
// Phase 5: the SSE server, the demo scenarios and "the server uses the same engine".
// Needs the episodes built (npm run sim -- --build), like the eval tests.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makePolicy } from "../eval/baselines";
import { runEpisode } from "../eval/run";
import { HYPOTHESES, type TickRecord } from "../engine/types";
import { demoCheck } from "../server/demo-check";
import { EVAL_FILE, EVAL_POLICIES, evalView } from "../server/eval-cache";
import { loadEpisode, loadTwinPair } from "../server/episodes";
import { createApp } from "../server/index";
import { runAll } from "../server/runner";
import { SCENARIOS } from "../server/scenarios";

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

interface SseEvent {
  event: string;
  data: any;
}

// Read an SSE response to the end (speed=0 streams finish on their own).
async function readSse(path: string): Promise<SseEvent[]> {
  const text = await (await fetch(base + path)).text();
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => {
      const event = /^event: (.*)$/m.exec(b)![1];
      const data = JSON.parse(/^data: (.*)$/m.exec(b)![1]); // throws on invalid JSON
      return { event, data };
    });
}

const maxDiff = (a: TickRecord, b: TickRecord) => Math.max(...HYPOTHESES.map((h) => Math.abs(a.probabilities[h] - b.probabilities[h])));

describe("SSE server", () => {
  it("replay: episode-start (no truth), at least 10 tick events with valid JSON, then the truth reveal", async () => {
    const evs = await readSse("/api/replay?split=test&episode=test-cascade-5139&speed=0");
    expect(evs[0].event).toBe("episode-start");
    expect(evs[0].data.registry.sources.length).toBeGreaterThan(10);
    expect(JSON.stringify(evs[0].data)).not.toMatch(/"(truth|type|hypothesis|true_reliability|clock_offset)"/);
    const ticks = evs.filter((e) => e.event === "tick");
    expect(ticks.length).toBeGreaterThanOrEqual(10);
    for (const t of ticks) {
      expect(t.data.record.tick_time).toBe(t.data.minute * 60);
      expect(HYPOTHESES.reduce((s, h) => s + t.data.record.probabilities[h], 0)).toBeCloseTo(1, 6);
      expect(typeof t.data.record.explanation.delta_summary).toBe("string");
    }
    const end = evs[evs.length - 1];
    expect(end.event).toBe("episode-end");
    expect(end.data.hypothesis).toBe("CASCADING_CRISIS");
  });

  it("twin: tick-left and tick-right in lockstep, identical posteriors up to the split, then a split event", async () => {
    const evs = await readSse("/api/twin?split=test&twin=test-twin-5221&speed=0");
    const left = evs.filter((e) => e.event === "tick-left").map((e) => e.data.record as TickRecord);
    const right = evs.filter((e) => e.event === "tick-right").map((e) => e.data.record as TickRecord);
    const split = evs[0].data.split_time;
    expect(left.length).toBeGreaterThan(10);
    expect(right.length).toBeGreaterThan(10);
    const pre = left.filter((r) => r.tick_time <= split);
    expect(pre.length).toBeGreaterThan(3);
    pre.forEach((r, i) => expect(maxDiff(r, right[i])).toBe(0));
    const splitAt = evs.findIndex((e) => e.event === "split");
    expect(splitAt).toBeGreaterThan(0);
    // the split event comes right before the first tick after split_time
    expect(evs[splitAt + 1].data.record.tick_time).toBeGreaterThan(split);
    expect(Math.max(...left.map((r, i) => maxDiff(r, right[i])))).toBeGreaterThan(0.1);
  });

  it("pause, step and resume control an open stream", async () => {
    const res = await fetch(`${base}/api/replay?split=test&episode=test-rumor_wave-5250&speed=0&paused=1`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const count = (name: string) => buf.split(`event: ${name}\n`).length - 1;
    let pending: ReturnType<typeof reader.read> | undefined; // one read at a time, kept across pumps
    const pump = async (ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        pending ??= reader.read();
        const r = await Promise.race([pending, new Promise<null>((ok) => setTimeout(() => ok(null), until - Date.now()))]);
        if (!r) break; // time is up; the read stays pending for the next pump
        pending = undefined;
        if (r.done) break;
        buf += dec.decode(r.value);
      }
    };
    await pump(300);
    const id = /"stream_id":"(s\d+)"/.exec(buf)![1];
    expect(count("tick")).toBe(0); // paused: nothing moves
    await fetch(`${base}/api/replay/step?id=${id}`, { method: "POST" });
    await pump(300);
    expect(count("tick")).toBe(1); // exactly one tick
    await fetch(`${base}/api/replay/resume?id=${id}`, { method: "POST" });
    await pump(3000);
    expect(count("tick")).toBe(40);
    expect(count("episode-end")).toBe(1);
  });

  it("/api/scenarios returns all 6 demo scenarios with episode ids that exist", async () => {
    const list = (await (await fetch(`${base}/api/scenarios`)).json()) as typeof SCENARIOS;
    expect(list.map((s) => s.label)).toEqual(["Twin Test", "Gateway Outage + Rumor Wave", "Cutout", "Real Cascade", "Rain Only (Lookalike)", "Rumor Wave"]);
    for (const s of list) {
      expect(s.split).toBe("test"); // demo episodes come from the test split
      if (s.mode === "twin") expect(loadTwinPair(s.split, s.twin!).map((e) => e.truth.twin_role).sort()).toEqual(["benign", "cascade"]);
      else expect(loadEpisode(s.split, s.episode!).episode_id).toBe(s.episode);
    }
  });

  it("/api/eval shows the same numbers as data/eval-results.json (written by npm run eval)", async () => {
    const saved = existsSync(EVAL_FILE()) ? JSON.parse(readFileSync(EVAL_FILE(), "utf8")) : {};
    if (!EVAL_POLICIES.every((p) => saved[`test/${p}`])) return; // run `npm run eval -- --split test --policy engine` first
    const v = (await (await fetch(`${base}/api/eval?split=test`)).json()) as ReturnType<typeof evalView>;
    expect(v.source).toBe("cache");
    expect(v.policies.map((p) => p.name).sort()).toEqual([...EVAL_POLICIES].sort());
    for (const p of v.policies) expect(p.summary).toEqual(saved[`test/${p.name}`].summary);
    expect(v.limitation).toMatch(/synthetic data/);
  });
});

describe("the server runs the same engine as the eval", () => {
  it("a cold-start replay gives exactly the records of the eval's engine policy on its first episode", () => {
    for (const id of ["test-cascade-5139", "test-cutout-5234"]) {
      const ep = loadEpisode("test", id);
      const evalRecords = runEpisode(makePolicy("engine", "test"), ep).records;
      expect(runAll(ep).map((p) => p.record)).toEqual(evalRecords);
    }
  });

  it("the demo DEGRADED override changes only the flag: at the default 0.5 it is identical to no override", () => {
    const ep = loadEpisode("test", "test-cutout-5234");
    const plain = runAll(ep).map((p) => p.record);
    expect(runAll(ep, { degradedBelow: 0.5 }).map((p) => p.record)).toEqual(plain);
    const demo = runAll(ep, { degradedBelow: 0.8 }).map((p) => p.record);
    expect(demo.some((r) => r.degraded)).toBe(true);
    expect(plain.some((r) => r.degraded)).toBe(false);
    expect(demo.map((r) => ({ ...r, degraded: false }))).toEqual(plain); // probabilities, actions, text: unchanged
  });
});

describe("demo-check", () => {
  it("all 6 demo scenarios still show what the demo script says", () => {
    const rs = demoCheck();
    expect(rs).toHaveLength(6);
    for (const r of rs) expect(r.pass, `${r.label}: ${r.detail}`).toBe(true);
  });
});

describe("no engine changes in Phase 5", () => {
  it("engine/, config/, sim/ and eval/ are unchanged since the Phase 4 commit d6c4656", () => {
    let diff: string;
    try {
      execSync("git cat-file -e d6c4656^{commit}", { stdio: "ignore" });
      diff = execSync("git diff --name-only d6c4656 -- engine config sim eval", { encoding: "utf8" });
    } catch {
      return; // not a git checkout with the Phase 4 history: nothing to compare against
    }
    expect(diff.trim()).toBe("");
  });
});
