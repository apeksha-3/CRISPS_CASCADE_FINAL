// server/index.ts
// Express server for the demo dashboard. `npm run dev` runs this file.
//   GET  /api/scenarios                        the demo scenarios (server/scenarios.ts)
//   GET  /api/replay?split=&episode=&speed=    SSE: episode-start, tick (one per minute), episode-end
//        &degraded_threshold=0.8               optional: show DEGRADED below this trust-weighted coverage
//                                             (default: the engine knob FILTER_KNOBS.degraded_below_coverage, 0.5)
//   GET  /api/twin?split=&twin=&speed=         SSE: both twins in lockstep: tick-left, tick-right, split
//   GET  /api/prior-shift?speed=               SSE: episode-summary after each of the 100 episodes
//   GET  /api/simple/replay?split=&episode=    SSE: the same replay with a plain-language view per tick (dashboard Layers 1 and 2)
//   GET  /api/nowcast/events                   the 3 real events and the nowcast's calibration report
//   GET  /api/nowcast/replay?event=&speed=     SSE: ML nowcast mode, one of the 3 real events through the exported models
//   GET  /api/eval?split=                      the eval table (same numbers as `npm run eval`)
//   POST /api/replay/pause | resume | step     control open streams (?id=<stream id>, default: all)
//   POST /api/replay/speed?speed=
//   /                                          the dashboard (dashboard/)
// speed = ticks per second: 1 = 1 s per tick, 4 = 250 ms, 0 = everything at once. &paused=1 opens a stream paused.
// Everything runs locally; the engine is the same one `npm run eval` uses.

import express, { type Request, type Response } from "express";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FILTER_KNOBS } from "../config/knobs";
import { DRIFT_KNOBS } from "../config/priors";
import { groupOf, type Split } from "../sim/dataset";
import { evalView } from "./eval-cache";
import { isSplit, loadEpisode, loadTwinPair } from "./episodes";
import { calibrationReport, eventSummary, nowcastTick, runtime } from "./nowcast";
import { priorShiftRun } from "./prior-shift";
import { EpisodeRunner, truthReveal } from "./runner";
import { SCENARIOS } from "./scenarios";
import { SimpleBuilder } from "./simple";
import { newPlayer, openSse, parseSpeed, targets } from "./stream";

const str = (x: unknown) => (typeof x === "string" ? x : "");

function splitOf(req: Request, res: Response): Split | undefined {
  const s = str(req.query.split) || "test";
  if (isSplit(s)) return s;
  res.status(400).json({ error: `unknown split ${s}` });
  return undefined;
}

// Optional ?degraded_threshold=<0..1>: a demo-only DEGRADED threshold (the Cutout scenario
// sends 0.8). Missing = undefined = the engine default. Bad value = 400 and null.
function degradedThreshold(req: Request, res: Response): number | undefined | null {
  const raw = str(req.query.degraded_threshold);
  if (raw === "") return undefined;
  const x = Number(raw);
  if (Number.isFinite(x) && x > 0 && x <= 1) return x;
  res.status(400).json({ error: `degraded_threshold must be a number in (0, 1], got ${raw}` });
  return null;
}

// What the dashboard may know at the start: the public city and the clock. Not the type.
function episodeStart(ep: ReturnType<typeof loadEpisode>, split: Split, extra: Record<string, unknown> = {}) {
  return { episode_id: ep.episode_id, split, duration: ep.duration, ticks: Math.floor(ep.duration / 60), registry: ep.registry, ...extra };
}

async function replay(req: Request, res: Response): Promise<void> {
  const split = splitOf(req, res);
  if (!split) return;
  const id = str(req.query.episode);
  let ep;
  try {
    ep = loadEpisode(split, id);
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
    return;
  }
  const degradedBelow = degradedThreshold(req, res);
  if (degradedBelow === null) return;
  const runner = new EpisodeRunner(ep, { degradedBelow });
  const send = openSse(res);
  const player = newPlayer(req, res, parseSpeed(req.query.speed), req.query.paused === "1");
  const threshold = degradedBelow ?? FILTER_KNOBS.degraded_below_coverage;
  send("episode-start", episodeStart(ep, split, { stream_id: player.id, degraded_threshold: threshold, demo_threshold: threshold !== FILTER_KNOBS.degraded_below_coverage }));
  while (!runner.done() && !player.closed) {
    await player.gate();
    if (player.closed) break;
    send("tick", runner.next());
  }
  if (!player.closed) send("episode-end", truthReveal(ep, groupOf(ep)));
  res.end();
}

// The same replay as /api/replay, with a plain-language `view` added to every tick (Layers 1 and 2 of the dashboard).
async function simpleReplay(req: Request, res: Response): Promise<void> {
  const split = splitOf(req, res);
  if (!split) return;
  let ep;
  try {
    ep = loadEpisode(split, str(req.query.episode));
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
    return;
  }
  const degradedBelow = degradedThreshold(req, res);
  if (degradedBelow === null) return;
  const runner = new EpisodeRunner(ep, { degradedBelow });
  const builder = new SimpleBuilder(ep.registry);
  const send = openSse(res);
  const player = newPlayer(req, res, parseSpeed(req.query.speed), req.query.paused === "1");
  send("episode-start", { ...episodeStart(ep, split, { stream_id: player.id }), mode: "rules" });
  while (!runner.done() && !player.closed) {
    await player.gate();
    if (player.closed) break;
    const tick = runner.next();
    send("tick", { minute: tick.minute, view: builder.view(tick, runner.engine) }); // no probabilities leave the server on this endpoint
  }
  if (!player.closed) send("episode-end", truthReveal(ep, groupOf(ep)));
  res.end();
}

// ML nowcast mode: one of three real events, replayed tick by tick (5 minutes of real time per tick) through the exported models.
async function nowcastReplay(req: Request, res: Response): Promise<void> {
  const rt = runtime();
  const ev = rt.events.find((e) => e.id === str(req.query.event));
  if (!ev) {
    res.status(404).json({ error: `unknown event ${str(req.query.event)}` });
    return;
  }
  const send = openSse(res);
  const player = newPlayer(req, res, parseSpeed(req.query.speed), req.query.paused === "1");
  send("episode-start", { ...eventSummary(rt, ev), stream_id: player.id, mode: "nowcast" });
  for (let i = 0; i < ev.ticks.length && !player.closed; i++) {
    await player.gate();
    if (player.closed) break;
    send("tick", nowcastTick(rt, ev, i));
  }
  if (!player.closed) send("episode-end", eventSummary(rt, ev));
  res.end();
}

async function twin(req: Request, res: Response): Promise<void> {
  const split = splitOf(req, res);
  if (!split) return;
  let pair;
  try {
    pair = loadTwinPair(split, str(req.query.twin));
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
    return;
  }
  const [a, b] = pair;
  const left = new EpisodeRunner(a);
  const right = new EpisodeRunner(b);
  const split_time = a.truth.split_time!; // shown as the SPLIT line (a property of how the twins were built)
  const send = openSse(res);
  const player = newPlayer(req, res, parseSpeed(req.query.speed), req.query.paused === "1");
  send("episode-start", {
    stream_id: player.id,
    twin: a.truth.twin_pair_id,
    split,
    split_time,
    left: episodeStart(a, split),
    right: episodeStart(b, split),
    ticks: Math.max(left.ticks, right.ticks),
  });
  let splitSent = false;
  while ((!left.done() || !right.done()) && !player.closed) {
    await player.gate();
    if (player.closed) break;
    // both twins advance one minute together (lockstep); the shorter one just stops
    const l = left.done() ? undefined : left.next();
    const r = right.done() ? undefined : right.next();
    const now = (l ?? r)!.record.tick_time;
    if (!splitSent && now > split_time) {
      send("split", { split_time, minute: split_time / 60 });
      splitSent = true;
    }
    if (l) send("tick-left", l);
    if (r) send("tick-right", r);
  }
  if (!player.closed) send("episode-end", { left: truthReveal(a, groupOf(a)), right: truthReveal(b, groupOf(b)) });
  res.end();
}

async function priorShift(req: Request, res: Response): Promise<void> {
  let run;
  try {
    run = priorShiftRun();
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
    return;
  }
  const send = openSse(res);
  const player = newPlayer(req, res, parseSpeed(req.query.speed), req.query.paused === "1");
  send("episode-start", { stream_id: player.id, length: run.length, shift_at: run.shift_at, cusum_threshold: DRIFT_KNOBS.threshold });
  for (let i = 0; i < run.length && !player.closed; i++) {
    await player.gate(250); // speed 1: 250 ms per episode (25 s for all 100)
    if (player.closed) break;
    send("episode-summary", run.step(i));
  }
  if (!player.closed) send("episode-end", { length: run.length });
  res.end();
}

export function createApp(): express.Express {
  const app = express();
  app.get("/api/scenarios", (_req, res) => {
    res.json(SCENARIOS);
  });
  app.get("/api/replay", (req, res) => void replay(req, res));
  app.get("/api/simple/replay", (req, res) => void simpleReplay(req, res));
  app.get("/api/nowcast/events", (_req, res) => {
    try {
      const rt = runtime();
      res.json({ events: rt.events.map((e) => eventSummary(rt, e)), calibration: calibrationReport(rt) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  app.get("/api/nowcast/replay", (req, res) => void nowcastReplay(req, res));
  app.get("/api/twin", (req, res) => void twin(req, res));
  app.get("/api/prior-shift", (req, res) => void priorShift(req, res));
  app.get("/api/eval", (req, res) => {
    const split = splitOf(req, res);
    if (!split) return;
    try {
      res.json(evalView(split));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  const control = (fn: (p: ReturnType<typeof targets>[number]) => void) => (req: Request, res: Response) => {
    const ps = targets(req.query.id);
    ps.forEach(fn);
    res.json({ ok: true, streams: ps.map((p) => ({ id: p.id, paused: p.paused, speed: p.speed })) });
  };
  app.post("/api/replay/pause", control((p) => p.pause()));
  app.post("/api/replay/resume", control((p) => p.resume()));
  app.post("/api/replay/step", control((p) => p.step()));
  app.post("/api/replay/speed", (req, res) => control((p) => p.setSpeed(parseSpeed(req.query.speed)))(req, res));
  app.use(express.static(join(process.cwd(), "dashboard")));
  return app;
}

// Run directly (npm run dev): listen on PORT or 3000.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    console.log(`First 10 Minutes demo server listening on port ${port}`);
    console.log(`  open http://localhost:${port}`);
  });
}
