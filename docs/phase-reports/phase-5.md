# Phase 5 report: dashboard, SSE server, twin mode, demo scenarios

The presentation layer. An Express server replays episodes through the real engine and pushes one TickRecord per simulated minute over Server-Sent Events; a vanilla HTML/JS/CSS dashboard draws it. Four modes (Single, Twin, Prior-Shift, Eval), six demo scenarios picked from the test split, and `npm run demo-check`.
**No engine logic changed**: `git diff d6c4656 HEAD -- engine/` is empty, and so are `config/`, `sim/` and `eval/` (a test checks this).

## Gate summary

| Gate item | Result | Pass? |
|---|---|---|
| `npx tsc --noEmit` and `npm test` | tsc exit 0, **112/112 tests** (was 103; 9 new in `tests/server.test.ts`) | yes |
| `npm run dev` starts | "First 10 Minutes demo server listening on port 3000" | yes |
| Single mode, cascade scenario at 4x | flat P(cascade) <= 0.12 for 12 minutes, jump to 0.65 at 13:00, ALERT 14:00, ESCALATE 15:00, then 0.92-0.99 to the end | yes |
| Twin mode | 9 of 9 pre-split ticks identical (max dP 0); first dP > 0.05 at 13:00 (4 min after the 09:00 split); dP 0.639 within 5 min; 0.956 at the end | yes, with the 5-minute bar (see below) |
| Prior-shift mode | P(cascade) prior 0.056 at ep 25, 0.220 at ep 75: rises after 50. Brier 51-100 adaptive 0.401 vs static 0.397 shown as the missed gate | yes (the honest result is on screen) |
| Eval mode | all four policies, same numbers as `npm run eval` (tested field by field) | yes |
| `npm run demo-check` | **6 of 6 pass** | yes |
| "Why it changed" at an action change | exact text below | yes |
| DEGRADED banner in the cutout scenario | appears 15:00-31:00, "coverage at 75%" | yes, with a **demo-only threshold of 0.8** (engine default 0.5 never fires) |
| `git diff d6c4656 HEAD -- engine/` | empty (0 lines) | yes |
| README LIMITATIONS covers >= 5 of the 8 items | all 8 | yes |
| Sanity: dashboard numbers = `npm run eval` | eval table read from the file the eval writes; replay records equal the eval engine's records (test) | yes |

Two things need your eye:

1. **Twin divergence within 3 minutes is impossible on this simulator.** I replayed all 30 test pairs and all 30 dev pairs. No pair differs by more than 0.1 within 3 minutes of the split (best: 0.068, dev-twin-1201). After the split, the next cascade stage needs about 2 minutes to start, and its first report needs 1-3 more minutes to arrive. So `demo-check` uses your fallback bar: "> 0.1 within **5** minutes". The chosen pair, test-twin-5221, reaches 0.639.
2. **DEGRADED is shown with a demo threshold.** At the engine's 0.5, DEGRADED fires on 0 of 302 test episodes. The lowest trust-weighted coverage is 0.74. For the Cutout scenario only, the server passes a different threshold (0.8) through `EngineOptions.filterConfig`. No engine file changed, and the banner says it is a demo threshold. A test shows that the override changes only the flag: probabilities, actions and text stay identical. If you want it for real, set `degraded_below_coverage` to 0.8 in `config/knobs.ts` (a config change, so Phase 6). On test it would then fire on 21 of 302 episodes, every one with a gateway gone silent: 14 sensor_failure:outage, 4 gateway_outage lookalikes, 3 gateway cutouts. It never fires on camera cutouts, whose coverage stays at 0.88 or above.

## What was built

| File | What |
|---|---|
| `server/index.ts` | Express app (`createApp()`), the 5 endpoints + pause / resume / step / speed controls, static `dashboard/`. `npm run dev` listens on `PORT` or 3000 and prints the URL |
| `server/runner.ts` | `EpisodeRunner`: the real `Engine` from `engine/tick.ts`, fed only the events that arrived by each tick (same arrival order as `eval/run.ts`). Adds the feed events (heartbeats left out), DUP / Q flags, evidence-unit summaries with member ids and LLR, forecast status, and trust-weighted coverage. `truthReveal()` for episode-end |
| `server/stream.ts` | SSE writer and a `Player` per open stream: delay = 1000 ms / speed, pause, step one tick, change speed, stop when the browser disconnects |
| `server/scenarios.ts` | The 6 demo scenarios with labels, descriptions, episode ids and the expectation `demo-check` verifies |
| `server/demo-check.ts` | `npm run demo-check`, also run as a test |
| `server/eval-cache.ts` | `/api/eval`: reads `data/eval-results.json`. Any policy missing there is run with the eval's own code (`runSequence` + `summarize`, same order) and saved to that file |
| `server/prior-shift.ts` | The 100-episode sequence played in order, adaptive engine and static-prior engine side by side, same code path as `npm run eval -- --split prior-shift` |
| `server/episodes.ts` | Load an episode or twin pair from `data/episodes/` (ids checked, no paths) |
| `dashboard/index.html`, `app.js`, `style.css` | The dashboard: vanilla JS, `<canvas>` charts, dark theme default + light toggle, no framework, no chart library |
| `tests/server.test.ts` | 9 tests (below) |
| `package.json` | `demo-check` script. No new dependencies |
| `README.md` | "How to run the demo", Phase 5 status, R12 row, LIMITATIONS rewritten with all 8 items |

### Endpoints

| Endpoint | Events / response |
|---|---|
| `GET /api/replay?split=&episode=&speed=` | `episode-start` {episode_id, split, duration, ticks, registry, stream_id, degraded_threshold, demo_threshold} (no type, no truth), `tick` x N, `episode-end` {truth reveal} |
| `GET /api/twin?split=&twin=&speed=` | `episode-start` {split_time, left, right, ...}, then per minute `tick-left` + `tick-right`, one `split` just before the first tick after split_time, `episode-end` {left, right} |
| `GET /api/scenarios` | the 6 scenarios |
| `GET /api/eval?split=` | {split, source: cache or computed, policies: [{name, summary, groups}], limitation} |
| `GET /api/prior-shift?speed=` | `episode-start` {length, shift_at, cusum_threshold}, `episode-summary` x 100, `episode-end` |
| `POST /api/replay/pause`, `resume`, `step`, `speed?speed=` | `?id=<stream_id>`; with no id they act on every open stream |

Speed: 1 = 1 s per tick, 2 = 500 ms, 4 = 250 ms, 0 = everything at once. `&paused=1` opens a stream paused (used by "next tick" before Play). Prior-shift: 250 ms per episode at 1x.

Every `tick` (and `tick-left` / `tick-right`) carries:

```
{ minute, record: TickRecord,                 // exactly what Engine.tick() returned
  events: [{id, arrived_at, occurred_at, source_id, source_type, zone_id, kind, severity, value, text, retracts, dup, quarantined}],
  heartbeats,                                  // count only, not listed
  units: [{unit_id, unit_type, kind, zone_id, n, weight, llr, supports, members: [event ids]}],
  forecast_status: {kind: confirmed | missed | off_window},
  coverage_weighted, degraded_threshold }
```

### Demo scenarios (all from the test split)

I picked each one by replaying every candidate with the server's cold-start runner and reading the traces. Scan output is summarized here.

| Scenario | Episode | Why this one |
|---|---|---|
| Twin Test | test-twin-5221 | Largest divergence within 5 min of the split of all 30 test pairs: 0.639 (next best 5202: 0.446; median about 0.04). Twin A goes PREPARE to ESCALATE, twin B stays at PREPARE |
| Gateway Outage + Rumor Wave | test-sensor_failure-5045 | Lying gateway gw0: 25-27 sensors report the identical value 99.9. P(sensor_failure) 0.73 at minute 6, 0.97 at 7. Engine max PREPARE, count-threshold ESCALATE. No episode type combines a gateway lie with a rumor wave, so this is the gateway-lie half (your "OR") |
| Cutout | test-cutout-5234 | Gateway gw0 dark from 12:22 to 30:22 on a real cascade: "Gateway gw0 lost: 26 sensors now dark, confidence widened". P(cascade) is held at 0.54-0.67 (ALERT) while coverage is 0.77, and goes to ESCALATE at 33:00 once the sensors are back. Lowest weighted coverage on test (0.75) |
| Real Cascade | test-cascade-5139 | Clean shape: flat, then a jump, early ALERT (14:00; only one of the 40 test cascades alerted earlier, at 13:00). Forecast confirmed: "the forecast power_comms_load arrived on schedule". 4 of 5 stages confirmed (traffic missed) |
| Rain Only (Lookalike) | test-rain_only-5170 | Engine max PREPARE, Brier 0.069 (best of the 4 rain days where count-threshold ESCALATEs). The explanation shows "shares one weather cause with its zone" |
| Rumor Wave | test-rumor_wave-5250 | 44 reports of one story from z04 in 3 minutes (67 citizen reports in the episode). One narrative unit, weight 1.0. Engine max PREPARE, count-threshold ESCALATE |

Rejected: cascades whose ALERT came late (e.g. 5131 at minute 31). Rain-only days where the engine also alerted (5162, 5167, 5168). Camera cutouts, whose coverage never drops below 0.88.

## Gate (real output)

### 1. Type check and tests

```
$ npx tsc --noEmit; echo "tsc exit=$?"
tsc exit=0
$ npm test
 Test Files  18 passed (18)
      Tests  112 passed (112)
   Duration  39.36s
```

New tests (`npx vitest run --reporter=verbose tests/server.test.ts`):

```
 ✓ SSE server > replay: episode-start (no truth), at least 10 tick events with valid JSON, then the truth reveal
 ✓ SSE server > twin: tick-left and tick-right in lockstep, identical posteriors up to the split, then a split event
 ✓ SSE server > pause, step and resume control an open stream
 ✓ SSE server > /api/scenarios returns all 6 demo scenarios with episode ids that exist
 ✓ SSE server > /api/eval shows the same numbers as data/eval-results.json (written by npm run eval)
 ✓ the server runs the same engine as the eval > a cold-start replay gives exactly the records of the eval's engine policy on its first episode
 ✓ the server runs the same engine as the eval > the demo DEGRADED override changes only the flag: at the default 0.5 it is identical to no override
 ✓ demo-check > all 6 demo scenarios still show what the demo script says
 ✓ no engine changes in Phase 5 > engine/, config/, sim/ and eval/ are unchanged since the Phase 4 commit d6c4656
```

### 2. `npm run dev`

```
$ npm run dev
> first-10-minutes@0.0.1 dev
> tsx server/index.ts

First 10 Minutes demo server listening on port 3000
  open http://localhost:3000
```

### 3. Each mode, driven in headless Chromium (Playwright) against port 3000

The script picks a scenario, clicks Play, waits for the end, reads the DOM and takes screenshots. The screenshots are in the project files under `phase-reports/phase-5-screens/`. It saw 0 console errors, and at 390 px phone width the page had no horizontal scroll (scrollWidth 390).

**Single mode, Real Cascade at 4x** (45 ticks in about 11 s). The belief timeline is a stacked area: green NOISE on top, red CASCADE at the bottom. For 12 minutes it stays at base-rate-like proportions, with P(cascade) between 0.07 and 0.12 and a little more ISOLATED as drainage and calls come in. At 13:00, hospital arrivals in z04 jump P(cascade) to 0.65. The action strip along the top turns amber (ALERT) at **14:00**, one tick later, because hysteresis needs 2 ticks above. It turns red (ESCALATE) at **15:00**, when the forecast power-grid load arrives. From then on the chart is almost solid red (0.92-0.99). After the end, the truth card shows `CASCADING_CRISIS · cascade · critical time 10:07 · onset 02:01`, and a red dotted "critical time" line appears on the chart. That line sits about 4 minutes before the ALERT: the negative lead time, visible on screen.

P(cascade) per minute from the stream: `0.10 0.09 0.09 0.08 0.08 0.07 0.08 0.10 0.09 0.08 0.12 0.10 0.65 0.67 0.94 0.93 0.92 0.98 ...`

**Twin mode, test-twin-5221** (DOM text read by the script):

```
twin identity: Pre-split check: 9 of 9 ticks identical (max |ΔP| = 0.0e+0) · split at 09:00 · now |ΔP| = 0.956
twin callout: First tick with |ΔP| > 0.05: 13:00 (4 min after the split)
  Twin A: P(cascade) 0.61 · PREPARE  P(cascade) rose from 0.19 to 0.61 because hospital_arrivals_unusual anomalies arrived in z06,
          and emergency_call_spike anomalies arrived in z01, and the forecast hospital_arrivals_unusual arrived on schedule.
  Twin B: P(cascade) 0.18 · PREPARE  Little change: 12 evidence unit(s) updated, P(cascade) 0.18.
```

Both panels have green "Identical prefix" borders up to the dashed SPLIT line. After it, twin A's border turns amber ("Diverging") and its timeline goes red. Twin B stays green (NOISE) and ends at PREPARE. Truth card: `Twin A: CASCADING_CRISIS (cascade) · Twin B: NOISE (benign)`.

**Prior-shift mode** (100 episodes, about 15 s at 4x):

```
shift stats: Brier 1-50: adaptive / static 0.392 / 0.373 · Brier 51-100: adaptive / static 0.401 / 0.397
             True cascades 1-50 / 51-100: 4 / 12 · P(cascade) prior at ep 25 / 75: 0.056 / 0.220
shift cusum: No drift alarm: CUSUM peaked at 2.73, alarm threshold 3. (On 9 of 10 dev-seeded copies of this sequence it did fire, around episode 70.)
shift verdict: Honest result: the prior adapts as designed (it rises after episode 50), but after the regime change the adaptive
               engine's Brier is not better than the static prior's (0.401 vs 0.397, lower is better). ...
               This is the Phase 4 gate item that was missed.
```

The red prior line drifts down to about 0.05 in the normal half. It climbs after the dashed "Regime change" line at 50 and reaches 0.22 around episode 75-90. The dot row has 4 red dots before 50 and 12 after. These match Phase 4 exactly (0.401 / 0.397, 0.056 / 0.220, no CUSUM alarm).

**Eval mode** (test split, read from `data/eval-results.json`):

```
policy (test, 302 episodes) | Brier | Log-loss | False alarms   | Cost / tick | Lead time (min) | Flip-flops / ep | Forecast acc.
engine (tuned)              | 0.414 | 0.747    | 2.5% (4/158)   | 2.62        | -6.17 (88/88)   | 0.79            | 80.0%
engine (hand-set)           | 0.427 | 0.767    | 2.5% (4/158)   | 2.63        | -6.40 (88/88)   | 0.81            | 80.0%
count-threshold             | 0.724 | 1.324    | 34.8% (55/158) | 7.73        | -3.88 (85/88)   | 1.95            | —
always-watch                | 0.797 | 1.493    | 0.0% (0/158)   | 44.86       | — (0/88)        | 0.00            | —
limit: Calibrated on synthetic data only — see README LIMITATIONS for details
```

Identical to `npm run eval -- --split test --policy engine` this session (`engine 0.414 0.747 2.62 2.5% -6.17 240 0 80.0%`, `count-threshold 0.724 1.324 7.73 34.8% -3.88`). There are 18 expandable rows, one per episode type, each with all 4 policies.

### 4. `npm run demo-check`

```
$ npm run demo-check
PASS  Twin Test                    split 09:00: pre-split max |dP| 0.0e+0 (must be < 1e-9); max |dP| within 5 min after 0.639 (must be > 0.1), first > 0.1 at 13:00
PASS  Gateway Outage + Rumor Wave  highest action PREPARE (must be <= PREPARE)
PASS  Cutout                       DEGRADED on 17 ticks (15:00-31:00); lowest trust-weighted coverage 75%, threshold 80% (demo-only threshold; engine default 50%); highest action ESCALATE
PASS  Real Cascade                 highest action ESCALATE; first ALERT+ at 14:00
PASS  Rain Only (Lookalike)        highest action PREPARE (must be <= PREPARE)
PASS  Rumor Wave                   highest action PREPARE (must be <= PREPARE)

all 6 demo scenarios pass
```

### 5. "Why it changed" at an action change (exact text)

Real Cascade, 15:00, ALERT -> ESCALATE:

> P(cascade) rose from 0.67 to 0.94 because power_comms_load anomalies arrived in z06, and hospital_arrivals_unusual anomalies arrived in z04, and the forecast power_comms_load arrived on schedule. Action ALERT -> ESCALATE.

Top 3 evidence shown under it:
- 3 hospital_arrivals_unusual reports in z04, each within 3 min of another (one incident, counted as 2.1) [min 11.4-14.5]: CASCADE, LLR +1.04
- power_comms_load from utl-z06-1 in z06 [min 13.2]: CASCADE, LLR +0.59
- 2 rain_heavy reports in z05, each within 3 min of another (one incident, counted as 1.5), shares one weather cause with its zone [min 12.0-13.4]

Gateway scenario, 09:00: the top evidence reads "gateway gw0: 27 sensors report the identical value 99.9 (one unit: a lying gateway)".

Weak spot, shown on screen as it is: the ALERT tick (14:00) says only "Little change: 15 evidence unit(s) updated, P(cascade) 0.67. Action PREPARE -> ALERT.". The belief jumped one tick earlier, at 13:00, and the action followed a tick later because of hysteresis. The template does not say "the action caught up with last minute's jump". That fix belongs in `engine/explain.ts`, so I left it for Phase 6.

### 6. DEGRADED banner

Cutout scenario, from 15:00 to 31:00, bottom of the screen:

> DEGRADED — coverage at 75%, confidence widened (demo threshold: below 80% trust-weighted coverage; engine default 50%)

The widening itself is not a demo trick: `posterior = c x raw + (1 - c) x prior` runs at every coverage level (`engine/filter.ts`). That is why P(cascade) stays around 0.55-0.67 during the cutout and rises to 0.83+ once the gateway is back. Only the banner flag needed the lower bar. The table below shows, for each episode group on test, the lowest trust-weighted coverage and how many episodes would show DEGRADED at 0.8:

```
cutout:cameras             n 12 min 0.88 below0.8 0
cutout:gateway             n 8  min 0.75 below0.8 3
lookalike:gateway_outage   n 9  min 0.75 below0.8 4
sensor_failure:outage      n 20 min 0.74 below0.8 14
(every other group: min 1.00)
ALL 302 min 0.74 below 0.8: 21
```

### 7. No engine changes

```
$ git diff d6c4656 HEAD -- engine/; echo "exit=$? lines=$(git diff d6c4656 HEAD -- engine/ | wc -l)"
exit=0 lines=0
$ git diff --stat d6c4656 HEAD -- engine config sim eval
(empty)
```

The server builds the same `Engine` class with the same defaults. The test "a cold-start replay gives exactly the records of the eval's engine policy" compares every field of every TickRecord, for a cascade and a cutout episode.

### 8. README LIMITATIONS

All 8 items, numbered in the README: synthetic data; hand-specified causal graph and likelihoods; lightweight learning; city-wide decision only; full recompute per tick; no LLM (template explanations); a different cost model or format needs recalibration; negative lead time. It also notes DEGRADED, the twin divergence time, the dev/test mix and trust by type.

## Three concepts

1. **Server-Sent Events (SSE).** A normal HTTP response that the server keeps open and writes small text blocks into, one per tick: `event: tick` then `data: {json}` then a blank line. The browser's built-in `EventSource` turns each block into a message. It is one-way (server to browser), which is all a replay needs, and it is simpler than WebSockets. One gotcha: when the server ends the stream, `EventSource` reconnects automatically and would replay the episode again, so the dashboard calls `close()` on `episode-end`.
2. **A presentation layer must not have its own math.** The dashboard numbers come from the same code as the eval. The replay uses the same `Engine` class (tested record by record against the eval's engine policy). The Eval tab reads the JSON file `npm run eval` writes, and if that file is missing it runs the eval's own functions. The prior-shift view calls the same `runEpisode` + `afterEpisode` loop. So the numbers on screen and in the report can't drift apart.
3. **Configuration through options, not edits.** The demo needed a different DEGRADED threshold for one scenario. The engine already takes its filter knobs as a constructor option (`EngineOptions.filterConfig`), so the server passes `{...FILTER_KNOBS, degraded_below_coverage: 0.8}` for that scenario only. The engine code stays untouched and the default stays 0.5. A test proves the override is faithful: at 0.5 it gives byte-identical records, and at 0.8 only the `degraded` flag changes.

## Assumptions (decided, not asked)

- **Every replay is a cold start.** Base rates from `config/priors.ts` and type-prior trust, like episode 1 of an eval run. `npm run eval` carries learned trust from episode to episode, so one episode's numbers inside the eval can differ slightly from its replay. The Eval tab and the Prior-Shift tab use the learning sequence; Single and Twin don't.
- **Demo scenarios come from the test split, as you asked.** Picking them meant replaying every test cascade, lookalike, twin, cutout, rumor and sensor-failure episode once more. That is a look at test, but no parameter changed because of it (Phase 5 changes no engine or config file). The dev split was used only to confirm that no twin pair diverges within 3 minutes.
- **Twin bar is 5 minutes, not 3** (no pair on test or dev reaches 0.1 within 3). Twin A and B keep the simulator's order (A = cascade in every test pair); the dashboard says which is which only at the end.
- **"Gateway Outage + Rumor Wave" is a gateway-lie episode only.** The simulator has no episode combining the two. The label is kept as written in the demo script.
- **The engine has no source type "gateway"** (gateways are not sources in the registry), so 📡 appears only for gateway events and the trust panel lists the 8 sensor and channel types.
- **Event feed badges.** DUP = the same event id arrived again (a retransmission the engine dedupes). RET = a later retraction named this event (struck through). Q = failed validation this tick. 🔗cluster:N = the event is in an evidence unit of N events at the latest tick. Heartbeats (about 1,000 per episode) are counted but not listed.
- **Forecast status.** ✓ / ✗ come from the engine's own forecast checker (`Engine.chain().resolved`); "off_window" shows as ✗. Resolved stages leave the forecast list, so they are listed below it as "Resolved so far".
- **Trust history.** Clicking a source type shows a sparkline of that type's mean trust over the episode's ticks plus the average Beta(a, b). Within one episode trust only moves by small in-episode bumps, so the sparkline is scaled to its own min-max.
- **Twin "diverging side"** = the side whose P(cascade) has moved further from its value at the split.
- **The split time is shown before the end.** It comes from the simulator's truth (how the pair was built). The dashboard needs it to draw the SPLIT line, and it says nothing about which twin is which.
- **Eval tab for dev / prior-shift.** If those policies are not in `data/eval-results.json`, the server runs them on first open (30-60 s) and saves them, exactly like the CLI would.
- **Pause / resume act on one stream by id.** Without an id they act on every open stream. A "step" control was added for the → key.
- **No screenshots in the repo.** They are in the project files only, to keep the repo light.
