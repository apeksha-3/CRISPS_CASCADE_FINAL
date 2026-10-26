# Phase 10 report: user dashboard, nowcast mode, rolling recalibration

Branch `phase-10-ui`, from `phase-9-nowcast` head `053e61d`. Engine, config, sim, eval and the Phase 9 models are byte-identical (`git diff 053e61d -- engine config sim eval ml/models ml/nowcast.ts` is 0 bytes). Runtime dependencies are still `express` only (Python is training-only, as in Phase 9; Playwright is used only to take the screenshots).

## Gate summary

| Gate item | Result |
|---|---|
| Frozen diff | empty (engine, config, sim, eval, the Phase 9 model JSON and `ml/nowcast.ts`) |
| Tests | **211/211** (187 earlier + 24 new in `tests/phase10.test.ts`); `tsc --noEmit` clean |
| Confidence gate, both branches | tested: shows when everything holds; hides for missing input, out-of-range input, too little recent evidence, and poor recent calibration, each with its reason; the limit is inclusive |
| Nowcast replay | tested: tick counts (98, 217, 36), determinism, probabilities in [0, 1], no number anywhere when the forecast is hidden, the Phase 9 model's output reproduced tick by tick, and the word "cascade" appears nowhere in the stream |
| Fixed versus rolling calibration | section A: **rolling not adopted** |
| Screenshots | `docs/screenshots/p10-*.png`: Layer 1 in each mode (and the gate), Layer 2 in each mode, Layer 3 in each mode, all at desktop (1280) and mobile (390) width |
| `npm run demo-check` | still passes: all 6 demo scenarios (`data/real-eval-p10-demo-check.txt`) |
| Two identical runs | section G |

## A. Rolling recalibration (`scripts/ml/recalibrate.py`)

Only the two Platt numbers are refitted; the model JSON is untouched. For each test month (2025-01 to 2026-10) the calibrator is refitted on the ticks of the 6 whole months before that month (at least 300 ticks and 20 of each class, else the fixed calibrator is kept; every test tick had a qualifying window), then used for that month. Test ticks, 95% intervals from 1,000 bootstrap resamples of whole test events (seed 12345); the difference column is rolling minus fixed.

| target | model | Brier, fixed | Brier, rolling | Brier difference | ECE, fixed | ECE, rolling | ECE difference |
|---|---|---|---|---|---|---|---|
| 311 | logistic | 0.1758 [0.128, 0.225] | 0.1585 [0.122, 0.199] | -0.0173 [-0.059, +0.028] | 0.150 [0.059, 0.232] | 0.071 [0.031, 0.129] | -0.079 [-0.142, +0.018] |
| 311 (dashboard model) | gbt | 0.1305 [0.111, 0.147] | 0.1219 [0.099, 0.147] | -0.0087 [-0.027, +0.015] | 0.098 [0.034, 0.160] | 0.044 [0.024, 0.097] | -0.054 [-0.087, +0.021] |
| traffic (dashboard model) | logistic | 0.0562 [0.039, 0.077] | 0.0599 [0.042, 0.083] | +0.0038 [+0.001, +0.008] | 0.023 [0.010, 0.047] | 0.019 [0.012, 0.041] | -0.004 [-0.024, +0.026] |
| traffic | gbt | 0.0600 [0.041, 0.083] | 0.0653 [0.045, 0.090] | +0.0053 [+0.002, +0.010] | 0.021 [0.008, 0.048] | 0.031 [0.019, 0.054] | +0.010 [-0.015, +0.039] |

**Decision: rolling calibration is not adopted, for either target.** The rule was "adopt only if ECE improves with an interval that excludes zero".
- **311 (GBT, the dashboard model):** the point estimate halves the calibration error (0.098 to 0.044), which is what you would hope, but the interval over events [-0.087, +0.021] includes zero. Logistic points the same way and is also not significant.
- **Traffic (logistic):** ECE barely moves (-0.004 [-0.024, +0.026]) and **Brier gets worse** (+0.004, interval [+0.001, +0.008], which excludes zero in the wrong direction). Traffic was already well calibrated with the fixed calibration (ECE 0.023).
- So the dashboard uses the fixed Phase 9 calibration. The rolling numbers are still computed and shown in the technical view. With 206 and 197 test events the experiment cannot rule out a real improvement for 311: it just does not clear the bar.

## B. The confidence gate (`ml/gate.ts`)

The nowcast shows a number only if **all four** hold, per forecast:
1. **The inputs exist**: the traffic forecast needs the road-speed feed (no DOT data in the last hour hides it); any missing feature hides it.
2. **The inputs are in range**: every continuous feature lies inside its training-set minimum and maximum (the model is not asked about weather it never saw).
3. **There is recent evidence**: at least 300 rain ticks with a known outcome, and at least 20 of them real events, in the last 3 whole months.
4. **It has been honest lately**: the expected calibration error over those 3 months is at most **0.10** (probabilities off by no more than 10 percentage points on average). Exactly 0.10 still shows.

Otherwise the dashboard says "Not enough reliable data to forecast" and shows no probability. If one forecast passes and the other fails, the passing one is shown and the sentence says the other is not. The limit (0.10) and the 3-month window were set before looking at the three demo events; they are not tuned to them. The recent error uses the calibration that is actually in use (fixed). The confidence bar is `1 - ECE / 0.15`, clipped to 0..1: full at perfect calibration, empty at 15 points; the gate's own limit leaves a shown forecast at least a third full. Bar words: High at 67% or more, Medium at 34% or more, otherwise Low.

What it does on the three real events: **Ida (Sep 2021): both forecasts shown** (311 recent ECE 0.043, traffic 0.085). **29 Sep 2023: both hidden** the whole way, the 311 forecast because the recent calibration error was 0.151 (above the limit) and the traffic forecast because there were only 208 recent checks with no real events. **14 Jul 2025: both shown** (recent ECE 0.037 and 0.009). That the gate hides the 2023 event is a feature of an honest system, not a bug, and it is the second-most useful thing the demo shows.

## C to G. The dashboard

- **Layer 1 (default):** one large status (rules mode: Watch, Prepare, Alert, Escalate; nowcast mode: "Low / Elevated / High chance of road slowdowns and flood reports in the next hour", or the gate message), one plain sentence, one confidence bar from calibration quality (rules mode: the engine's expected calibration error on the 302 simulator test episodes, 7.5 points, halved while sensors are going silent; nowcast mode: the recent error behind the shown forecasts), and a "What to do" line. No probability vectors, log-likelihoods or Brier scores. In rules mode the page never receives them: `/api/simple/replay` sends only the plain view (a test scans the stream for probabilities, llr, Brier and expected cost). Nowcast mode shows a plain frequency in the sentence ("about 7 in 10").
- **Layer 2 ("Show more detail"):** a zone grid coloured by severity (a word is written in each tile as well as the colour; a dashed outline marks where the next stage is expected) or, in nowcast mode, two citywide tiles (the model does not forecast by neighbourhood, and says so); a single threat-level line over time (grey bands where the forecast was hidden); "What's happening" and "What's expected" in sentences; the rumor callout when narrative clustering fired and no sensor confirms it; the alert log.
- **Layer 3 (Technical):** the existing dashboard for the rules engine (reached by the toggle; unchanged except that its header no longer sticks, so two bars do not overlap), and a technical panel for the nowcast: model score, fixed and rolling calibrated values, the gate's reason and the recent error behind it, the inputs, what really happened in the next hour, the Phase 9 test scores, the reliability table, and the fixed-versus-rolling table. **Every metric label has a one-line tooltip** (Brier, log-loss, false alarm rate, cost, lead time, flip-flops, forecast accuracy, ECE, AUC, ALERT+, reliability, positive rate); hover or keyboard focus.
- **Modes:** "Rules engine (simulator)" and "ML nowcast (real NYC)". The nowcast replays three real events from `ml/replay/events.json` (a small file cut from the cached tick data by `scripts/real/nowcast-replay-data.ts`, committed so the mode works without the 1 GB cache) tick by tick (5 minutes of real time per tick) through the exported models, with a banner that states what the model predicts ("road slowdowns and flood-report surges in the next hour, for New York City as a whole") and what it does not (flood depth, damage, injuries, neighbourhoods). All of its wording is in `ml/text.ts`; a test scans every string, including every generated sentence, for the word "cascade" and finds none.
- **Extras:** an alert log of recommendation changes with times; a time scrubber (drag back to any tick, "Back to live" returns); a mobile-width Layer 1 (single column, large touch targets). The scrubber works while a replay is still running.

## Screenshots

| | desktop | mobile |
|---|---|---|
| Layer 1, rules engine | `p10-layer1-rules-desktop.png` | `p10-layer1-rules-mobile.png` |
| Layer 1, nowcast (Ida, forecast shown) | `p10-layer1-nowcast-desktop.png` | `p10-layer1-nowcast-mobile.png` |
| Layer 1, nowcast (29 Sep 2023, gate closed) | `p10-layer1-nowcast-gate-desktop.png` | `p10-layer1-nowcast-gate-mobile.png` |
| Layer 2, rules (rumor wave, with the callout) | `p10-layer2-rules-desktop.png` | `p10-layer2-rules-mobile.png` |
| Layer 2, nowcast (14 Jul 2025) | `p10-layer2-nowcast-desktop.png` | `p10-layer2-nowcast-mobile.png` |
| Layer 3, rules (eval table, tooltip on Brier) | `p10-layer3-rules-desktop.png` | `p10-layer3-rules-mobile.png` |
| Layer 3, nowcast | `p10-layer3-nowcast-desktop.png` | `p10-layer3-nowcast-mobile.png` |

Taken with `node scripts/ui/screenshots.cjs` against a running server; the script fails on any page or console error and reported none.

## G. Two identical runs

`recalibrate.py`, `engine-ece.ts` and `nowcast-replay-data.ts` run twice, then every stream fetched twice from the running server (the stream id, which is random per connection, removed before hashing); SHA-256 prefixes:

```
run 1: recalibration 7ab83ecb4a  engine-calibration 91295b1d5a  replay-data 202119a0dd
run 2: recalibration 7ab83ecb4a  engine-calibration 91295b1d5a  replay-data 202119a0dd
streams (ida, 2023, 2025, rules cascade) run 1: 3ccc732c 3cd0ddc8 39d8e243 c229bd67
streams (ida, 2023, 2025, rules cascade) run 2: 3ccc732c 3cd0ddc8 39d8e243 c229bd67
```

## How to run

```
npm ci && npm run sim -- --build          # the simulator episodes (rules mode and the tests need them)
npm run dev                               # open http://localhost:3000 : Simple view, mode switch at the top
pip install -r scripts/ml/requirements.txt && python3 scripts/ml/recalibrate.py   # step A (needs data/ml/ticks.csv from Phase 9)
npx tsx scripts/real/engine-ece.ts        # the rules engine's calibration error, for its confidence bar
npx tsx scripts/real/nowcast-replay-data.ts   # rebuild ml/replay/events.json from the Phase 9 tick data
PORT=3100 npx tsx server/index.ts & node scripts/ui/screenshots.cjs               # screenshots
```

## Honest limits

- The nowcast replays three events, two of them from the model's own training years (Ida, 2023); only 14 Jul 2025 is out of sample. The replay shows what the model and the gate do, not how good the model is: Phase 9's test table is that.
- Rules mode confidence reflects the simulator's calibration, not any real city.
- The hidden 2023 forecast reflects a recent-calibration check on Phase 9's models; a different limit or window would show it. The limit is a policy choice, documented, not a fitted value.
- The zone severity is a display heuristic (the weight of strong evidence units in the last 10 minutes), not a probability.
