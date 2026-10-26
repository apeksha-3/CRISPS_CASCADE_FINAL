# The First 10 Minutes

**A Bayesian decision engine that classifies city crises in the first 10 minutes from noisy, messy sensor streams.**

CASCADE '26 · Theme 2 · Problem 1

Every simulated minute the engine reads a messy multi-source event stream (rain gauges, drainage sensors, traffic, cameras, emergency calls, hospitals, utilities, citizen reports) and outputs:

1. calibrated probabilities over **NOISE**, **SENSOR_FAILURE**, **ISOLATED_INCIDENT**, **CASCADING_CRISIS**
2. a recommended action (**WATCH**, **PREPARE**, **ALERT**, **ESCALATE**) that minimizes expected cost
3. a forecast of the next 3 events with time windows
4. a plain-language explanation of why the belief or action changed

Full spec: [docs/SPEC.md](docs/SPEC.md). Build history: [docs/phase-reports/](docs/phase-reports/). Demo script: [docs/demo-script.md](docs/demo-script.md).

## Quick Start

```bash
git clone https://github.com/Gunjal-mandawkar/CRISPS.git && cd CRISPS
git checkout claude/project-thread-0n9xmi
npm ci                       # express + dev tools, nothing else
npm run sim -- --build       # builds data/episodes/ (gitignored), ~15 s
npm run demo-check           # smoke test: all 6 demo scenarios must PASS (~1 s)
npm run dev                  # http://localhost:3000
```

Pick a scenario, press Play (or Space), set speed 4x. The exact eval numbers are already in [`data/final-eval-engine.txt`](data/final-eval-engine.txt), no run needed.

## Architecture

```
  sim/  seeded synthetic city (10 zones, ~180 sources) + hidden GroundTruth
    │   only EVENTS cross this line; the truth stays behind
    ▼
┌─ engine/  (one Engine.tick(now) per simulated minute, engine/tick.ts) ─────────────┐
│  adapter ─► validate ─► log ─► order + source-status                              │
│     ─► cluster + grouping ─► forecast check ─► filter ─► decide ─► explain        │
│  fallback.ts wraps the risky steps: any error = count-threshold baseline (R11)     │
└─────────────────────────────────────────────────────────────────────────────────────┘
    │   TickRecord every minute: probabilities, action, forecast, explanation, flags
    ├──► eval/     scores every tick against GroundTruth (Brier, cost, false alarms, lead)
    └──► server/   Express + Server-Sent Events ──► dashboard/ (vanilla HTML/JS)
    after an episode ends, its revealed outcome goes ONLY to engine/learn.ts:
       trust.ts (Beta trust) · priors.ts (decayed base rates) · drift.ts (CUSUM)
```

One sentence per component:

- **sim/** generates seeded episodes of 14 types (cascades, lookalikes, lying gateways, cutouts, rumor waves, twins...) with noise, lag, clock skew and retractions.
- **adapter** maps raw source records to one event schema, so a new data format only needs a new mapping.
- **validate** quarantines malformed or impossible events instead of crashing on them.
- **log** keeps an append-only event log, refuses anything that has not arrived yet (`arrived_at > now`), dedupes and applies retractions.
- **order + source-status** builds the cleaned 15-minute window (2-minute skew tolerance) and marks each source live, stale or dark from its heartbeats.
- **cluster + grouping** turns events into **evidence units**: near-duplicates, lying gateways, rumor waves and one zone's weather each count once.
- **forecast check** compares what arrived with the causal chain's expected next stages (confirmed forecasts add to CASCADE, missed ones subtract).
- **filter** is a log-space Bayesian forward filter that scores each unit times the trust of its sources.
- **decide** picks the action with the lowest expected cost, with hysteresis and a one-step lookahead.
- **explain** fills template sentences from the top evidence units: no LLM, fully deterministic.
- **learn** (between episodes only) updates per-source trust, the base rates and the drift detector.
- **eval/** is the only place besides `sim/` that reads ground truth.
- **server/ + dashboard/** replay episodes live over SSE with the same engine `npm run eval` uses.

**The honesty firewall: `engine/` never imports `sim/`.** `GroundTruth` lives in `sim/truth.ts`, and a test scans every engine file for static, dynamic and `require` imports of `sim/`. The engine cannot peek at the answer.

| Folder | What lives there |
|---|---|
| `config/` | Likelihood tables (dev-tuned, generated; hand-set originals kept), lags, transitions, costs, causal graph, knobs, priors, trust priors |
| `engine/` | The decision engine (pure TypeScript, no I/O) |
| `sim/` | Simulator and simulator-only truth types |
| `eval/` | Metrics, baselines, harness, tuner |
| `server/` | Express + SSE server, demo scenarios, `demo-check` |
| `dashboard/` | Vanilla HTML/JS/CSS, canvas charts, no framework |
| `tests/` | Vitest tests |
| `data/` | Built episodes (gitignored) and the committed final eval captures |

## How It Works

### 1. Honest probabilities

Four hypotheses, one posterior that always sums to 1. Each tick the filter adds up log-likelihoods of the fresh evidence units under each hypothesis (tables in `config/likelihoods.ts`), carries the belief forward with a small transition matrix, and normalizes. "Honest" is measured, not claimed: every tick of every test episode is scored with the **Brier score** against the hidden truth (0 perfect, 2 worst). The twin test checks that two episodes with byte-identical inputs get byte-identical beliefs up to the point where they differ.

### 2. Evidence grouping (50 reports of one thing are not 50 signals)

- **Near-duplicate discount:** same zone + same kind within 3 minutes = one incident, weighted `1 + ln(n)` instead of `n` (unless the values are spread out like a real surge).
- **Gateway correlation detector:** when 5+ sensors behind one gateway report the *identical* value, that is one broken gateway (evidence for SENSOR_FAILURE), not a flood.
- **Rumor cap:** a burst of citizen reports telling one story with no physical sensor backing it counts as one report.
- **Weather common cause:** rain + drainage + traffic in one zone count as one weather event.

### 3. Adaptive learning

- **Per-source Beta trust:** each source has a `Beta(a, b)` count of how often its reports matched the revealed outcome, forgetting old episodes at 0.98.
- **Decayed priors:** base rates are re-estimated from decayed outcome counts (0.95, floor 2%).
- **CUSUM drift detection:** a cumulative-sum detector on cascade surprises switches the prior to fast forgetting when the regime changes.

## Eval Results

Test split, 302 episodes, 13,038 ticks. Frozen numbers, identical in Phases 4, 5 and 6 ([`data/final-eval-engine.txt`](data/final-eval-engine.txt)):

| policy | Brier | Log-loss | Cost/tick | False alarms | Lead (min) | Flips |
|---|---|---|---|---|---|---|
| always-watch | 0.797 | 1.493 | 44.86 | 0.0% | - | 0 |
| count-threshold (naive baseline) | 0.724 | 1.324 | 7.73 | 34.8% | -3.88 | 589 |
| engine (hand-set tables) | 0.427 | 0.767 | 2.63 | 2.5% | -6.40 | 244 |
| **engine (tuned)** | **0.414** | **0.747** | **2.62** | **2.5%** | **-6.17** | **240** |

Key numbers for the tuned engine vs count-threshold:

- **Brier 0.414 vs 0.724** (lower is better calibrated)
- **False alarms 2.5% vs 34.8%** of benign episodes (4 of 158) ever reach ALERT or ESCALATE
- **Cost 2.62 vs 7.73 per tick**, 66% lower
- **Lead time -6.17 vs -3.88 minutes**: both alert after the critical time; the engine is about 2.3 minutes later (see Limitations)
- 88 of 88 cascades reach ALERT+; forecast accuracy 80%; 0 fallback ticks

Run it yourself: `npm run eval -- --split test --policy engine`

The other captures: [`final-eval-count-threshold.txt`](data/final-eval-count-threshold.txt), [`final-eval-always-watch.txt`](data/final-eval-always-watch.txt), [`final-eval-prior-shift.txt`](data/final-eval-prior-shift.txt) (100 episodes in order, monsoon regime from episode 51).

## Demo Scenarios

All six are test-split episodes (`server/scenarios.ts`). Every replay is a cold start (configured base rates, type-prior trust).

1. **Twin Test** (test-twin-5221): identical inputs for the first 9 minutes, identical beliefs; then hospital reports arrive on one side only, and within 5 minutes the beliefs differ by 0.64 (cascade side ESCALATE at 16:00, benign side stays at PREPARE).
2. **Gateway Outage + Rumor Wave** (test-sensor_failure-5045): gateway gw0 lies, 26 sensors report the identical value 99.9; count-threshold escalates, the engine reads one broken gateway (P(sensor_failure) 0.97 by minute 7) and never goes above PREPARE.
3. **Cutout** (test-cutout-5234): a real cascade during which gateway gw0 goes silent (26 sensors dark, coverage 75%); DEGRADED banner from 15:00 to 31:00; the engine reaches ALERT at 19:00 but holds there while it is half-blind, and escalates at 33:00 once the sensors are back.
4. **Real Cascade** (test-cascade-5139): the full chain; ALERT at 14:00, ESCALATE at 15:00 when the forecast power-grid load arrives on schedule.
5. **Rain Only (Lookalike)** (test-rain_only-5170): heavy rain with drainage and traffic anomalies but nothing downstream; count-threshold escalates, the engine stays at PREPARE.
6. **Rumor Wave** (test-rumor_wave-5250): 44 citizen reports of one story in 3 minutes, no sensor backing; counted as one report, the engine never goes above PREPARE.

Plus two non-episode modes: **Prior-Shift** (the learned prior across 100 episodes) and **Eval** (the table above, live).

`npm run demo-check` validates all scenarios pass.

**About the Cutout scenario:** the demo cutout scenario uses an elevated DEGRADED threshold (80%) to demonstrate the banner; the eval uses the default (50%). The default lives in `config/knobs.ts` (`FILTER_KNOBS.degraded_below_coverage = 0.5`); the dashboard asks for the demo value with `/api/replay?...&degraded_threshold=0.8`, and the banner says it is a demo threshold. At 50%, no simulated cutout triggers DEGRADED (lowest trust-weighted coverage on test: 74%).

**About the Twin Test:** the spec asks for divergence within 3 minutes; demo-check checks 5. Cascade stages take ~4 minutes to propagate, and no twin pair in test or dev differs by more than 0.1 within 3 minutes of the split (best: 0.068). We kept the honest window instead of faking a faster split.

Dashboard keys: Space play/pause, Right arrow = one tick while paused, R reset, 1 / 2 / 4 speed. Speed 4x = 250 ms per simulated minute (a 45-minute episode in about 11 s).

## Commands Reference

```bash
npm run sim -- --build                          # build dev (302), test (302), prior-shift (100) episodes into data/
npm run sim -- --stats                          # size / duration table per episode type
npm run sim -- --type cascade --seed 7 --print  # minute-by-minute timeline + ground-truth stage times
#   types: noise sensor_failure isolated cascade twin rain_only storm_calls flu_cluster gateway_outage
#          cutout rumor_wave duplicate_storm surge drifting   (options: --variant v --fuzz --json)

npm run tune -- --split dev                     # one-time tuning, dev only (refuses other splits); rewrites config/likelihoods.ts, config/lags.ts
npm run eval -- --split test --policy engine    # tuned engine vs hand-set vs baselines, trust panel
npm run eval -- --split test --policy count-threshold
npm run eval -- --split prior-shift --policy engine   # 100 episodes in order: adaptive vs static prior, CUSUM

npm run dev                                     # dashboard on http://localhost:3000 (PORT=xxxx to change)
npm run demo-check                              # replay the 6 demo scenarios and check each one
npm test                                        # vitest (needs the episodes built)
npx tsc --noEmit                                # type check
```

Conventions: time is whole seconds since episode start, one tick = 60 s. Seeds: dev 1000+, test 5000+, prior-shift 8000+. Same (type, seed) = byte-identical episode. Tuning only ever saw dev.

## Real data (Phase 7)

The engine was built and tuned only on the simulator. Phase 7 replays it, unchanged, on real NYC data. **What is real, what is synthetic, what is manual:**

| | |
|---|---|
| **Real** | Every observation: 311 requests, DOT traffic speeds, EMS dispatch and hospital arrivals, NYPD collisions, ASOS 1-minute rain (IEM). Times are real, converted from UTC to NYC local time with the real timezone rules. |
| **Real, but chosen by a fixed rule** | The 10 zones (the 10 community districts with the most 311 volume on dry control days), the control days (8 rain, 10 dry), and the baselines ("what is normal": dry control days only). Rules: [docs/real-zones.md](docs/real-zones.md). |
| **Synthetic** | The delivery delay of each event (the simulator's delay model, seeded by episode id), the 6 gateways (real NYC feeds have none), the source registry's heartbeat intervals, severity for collisions (an assumed table), and every mapping from a real column to an engine event kind ([real/adapt-*.ts](real/)). |
| **Manual** | The labels: which episodes are CASCADE or NOISE, the Ida onset (NWS flash flood emergency 21:28 EDT) and critical time (subways suspended 22:45), each with a URL and a confidence note in [real/labels.json](real/labels.json). |

```bash
npm ci
npm run real:fetch                         # raw data -> data/real/raw (300 MB, gitignored) + data/real/MANIFEST.md (row counts, SHA-256)
npm run real:build                         # adapters -> data/episodes/real/ + real/unmapped.json
npm run eval -- --split real --policy engine           # also count-threshold, always-watch
npm run real:actions -- engine             # what the policy did in each real cascade episode
npm run real:plot                          # docs/real-ida-timeline.html
npm run real:crosscheck                    # NOAA ISD hourly vs IEM rain
```

Result of Phase 7, stated plainly: on 34 real episodes the engine is **worse** than on the simulator (Brier 0.779 vs 0.414) and never reached ALERT on any of the 6 real cascade episodes (2 real events). The count-threshold baseline scores better on Brier (0.344) there. Causes, with an ablation, are in [docs/phase-reports/phase-7.md](docs/phase-reports/phase-7.md). Nothing was retuned.

**Phase 8 (real-data hardening).** Registering only DOT links that report on normal days removes about two thirds of the Brier gap to the simulator (engine 0.777 to 0.536 on the same 34 episodes), but the engine still never alerts on a real cascade: its P(cascade) never rises above the 0.10 base rate. Ten real flood events were collected (3 scored as cascades, 7 watched as "ambiguous"); results are reported per event with leave-one-event-out learning. See [docs/phase-reports/phase-8.md](docs/phase-reports/phase-8.md), [docs/real-events.md](docs/real-events.md) and [docs/real-ems-citywide.html](docs/real-ems-citywide.html).

```bash
npm run real:fetch && npm run real:build               # Phase 7 data and episodes (data/episodes/real, real-ambiguous)
npx tsx scripts/real/events-find.ts && npx tsx scripts/real/events-rank.ts   # NWS candidates, rain ranking, coverage
npx tsx scripts/real/fetch8.ts && npm run real:build   # Phase 8 event windows, then rebuild
npx tsx scripts/real/replay.ts --split real --mode loeo   # per-event replay, leave-one-event-out
npx tsx scripts/real/lags.ts                           # stage lags table
npx tsx scripts/real/citywide.ts                       # EMS and hospital citywide check
```

**Phase 9 (offline nowcast, not wired into the engine).** A calibrated model trained on real rain events, 2019 to 2026, predicts whether 311 flood reports (or DOT slowdowns) will be far above normal in the next hour. Split by time (train 2019-2023, validate 2024, test 2025 on) and by rain event; 764 events. On the test years it beats climatology and a rain-threshold rule for traffic slowdowns (Brier 0.056 against 0.072, well calibrated) and, for 311 reports, only the gradient-boosted model does, and not by more than a one-feature "311 is already elevated" rule; calibration drifts between years. Engine diagnostic: all of the simulator's cascade evidence comes from the late stages that real data lacks. See [docs/phase-reports/phase-9.md](docs/phase-reports/phase-9.md). Python (`scripts/ml/`) is for training only; the runtime is `ml/nowcast.ts`.

```bash
pip install -r scripts/ml/requirements.txt
npx tsx scripts/real/fetch9.ts && npx tsx scripts/real/nowcast-data.ts
python3 scripts/ml/train.py
```

## LIMITATIONS

Stated plainly. Read these before trusting any number in this repo.

1. **The benchmark data is synthetic.** Every dev, test and prior-shift episode comes from our own simulator; calibration (Brier 0.414) is verified only against that simulator. Phase 7 adds a small real-data replay (see limitations 11 to 16), which shows the engine does not transfer.
2. **The causal graph and likelihoods are hand-specified, not discovered from data.** The chain rain → drainage → traffic → calls → hospitals → power, its lags and the likelihood tables were written by hand, then nudged by a small dev-set tuner.
3. **Learning is lightweight.** Beta counts for trust and decayed counts for priors, plus CUSUM; no deep learning. Trust effectively learns source types, because the simulator redraws each source's reliability every episode.
4. **The decision is city-wide.** One action for the whole city; there is no per-zone action granularity, even though evidence is tracked per zone.
5. **Full recompute per tick.** Each tick re-clusters the 15-minute window. That is fine at simulator scale (~235 real events plus ~950 heartbeats per episode, ~180 sources) but not at real-city scale (80 lakh population) without incremental indexes.
6. **No LLM in the core loop.** Explanations are template-based, deterministic and reproducible; they can read clumsily ("Little change: 12 evidence unit(s) updated") but never invent anything.
7. **The organizers' cost model or data format may differ.** The adapter handles schema changes, but likelihoods, thresholds and costs would need recalibration on their data.
8. **Lead time is negative.** The first ALERT comes about 6 minutes after the critical time (-6.17 min; count-threshold -3.88). Cascades and lookalikes are indistinguishable until late-stage signals (hospitals, power) arrive, by design of the scenarios; committing earlier would buy false alarms.
9. **The DEGRADED threshold is tuned for the simulator's cutout severity.** The demo uses 80%, the eval 50%; a real deployment would calibrate against historical outage patterns.
10. **Prior-shift adaptation does not pay off within 50 episodes.** The learned P(cascade) does move toward the new regime (0.06 at episode 25, 0.22 at episode 75), but Brier after the shift is no better than a static prior (0.401 vs 0.397), and the CUSUM alarm does not fire on the committed prior-shift sequence (it fired on 9 of 10 dev-seeded copies, around episode 70). The benefit would need longer horizons.

11. **Very few real cascades.** The scored real split holds 3 cascade events (Ida 2021, the 29 Sep 2023 flood, the 14 Jul 2025 flood) cut into 9 episodes that are not independent, and 28 NOISE episodes; 7 more flood-warning events are watched but not scored. There are no real SENSOR_FAILURE or ISOLATED_INCIDENT episodes (none with a citable source). Any real-data number is an anecdote, not a statistic.
12. **Arrival delay is synthesized.** Real timestamps say when something happened. The time the engine "hears" it is the simulator's delay model added on top, so lead times and the ordering of near-simultaneous events are not measured on real transport.
13. **Gateways are synthetic.** Real NYC feeds have no gateways; the 6 `synth-gw` groups are regions we drew. Gateway-failure reasoning (R5) is therefore untested on real data.
14. **The power stage is weak.** The only power signal is 311 "ELECTRIC", an HPD building-wiring complaint, not grid load or an outage. It is flagged as a weak proxy and carries no severity.
15. **Traffic zones are approximate and the link inventory drifts.** DOT links and collisions have no community board, so each goes to the nearest zone centroid within 6 km. 73 of 137 links fall outside all 10 zones and are unused. Only links that report on normal days are registered (Phase 8), judged on 2022 dry days; for events in 2025 and 2026 the engine's P(sensor failure) is 0.4 to 0.57, which suggests the link list has changed since 2022. Before that fix, 8 to 14 of the 64 used links reported "no valid reading" for a whole episode, which the engine read as dark sources (11 links are now excluded, 53 registered).
16. **Labels are manual.** CASCADE and NOISE come from NWS and news sources and a rain-and-weekday rule, not from an instrument. "No major incident" on a rain-control day means only "no NWS flash flood emergency". Stage times the data cannot supply are null. The Central Park gauge is missing from the IEM 1-minute feed for the Ida peak hours (ISD has it).

17. **The nowcast is offline and its 311 label measures reporting, not damage.** Probabilities drift between years (Platt scaling fitted on 2024 is overconfident in 2025 to 2026) and need recalibration before any operational use; the model is not connected to the engine.

## Requirements

- **Node.js 22.12 or newer** (tested on Node 22.22; the pinned `vitest` 5 and `tsx` need it)
- No external services, no database, no API keys
- Runs offline on any laptop once `npm ci` has run (only runtime dependency: `express`)

Requirement-by-requirement status (R1-R12) is in [docs/phase-reports/phase-4.md](docs/phase-reports/phase-4.md) and [phase-5.md](docs/phase-reports/phase-5.md); the final freeze report is [phase-6.md](docs/phase-reports/phase-6.md).
