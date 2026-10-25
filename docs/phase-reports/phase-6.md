# Phase 6 report: freeze, README, demo prep

Code freeze. No new features, no parameter changes, no engine changes: `git diff c3b986e HEAD -- engine/ config/ sim/ eval/` is empty (a test checks it). What changed: the README (rewritten), the demo script and backup notes, the DEGRADED demo threshold now travels as a query parameter, comments on the 5-minute twin window, the four final eval captures in `data/`, and 9 new tests.

## Gate summary

| Gate item | Result | Pass? |
|---|---|---|
| `npx tsc --noEmit` and `npm test` | tsc exit 0; **121/121 tests**, 19 files (was 112; 9 new in `tests/phase6.test.ts`) | yes |
| `npm run demo-check` | **all 6 demo scenarios pass** | yes |
| Clean-state sequence (section F) | `rm -rf node_modules data` → `npm ci` → `sim --build` → 4 evals → tsc → test → demo-check, no errors; then the same again from a fresh `git clone` of the commit | yes |
| README LIMITATIONS | 10 numbered items (the 8 + DEGRADED threshold + prior shift) | yes |
| `docs/demo-script.md` | timed 0:00 / 0:30 / 1:30 / 2:15 script, real panel text and numbers | yes |
| 4 x `data/final-eval-*.txt` | engine 76 lines, count-threshold 38, always-watch 38, prior-shift 46 | yes |
| `git log --oneline -6` | phase 1 to phase 6 in order | yes |
| `git status -sb` | clean, tracking origin | yes |
| `npm run dev` | server on port 3000, `GET /` 200, landing page described below | yes |
| No engine logic changes | `git diff c3b986e HEAD -- engine/ config/knobs.ts config/likelihoods.ts config/priors.ts config/causal-graph.ts`: 0 lines | yes |
| SANITY: eval numbers frozen | engine Brier 0.414, false alarms 2.5%, cost 2.62 (also log-loss 0.747, lead -6.17, flips 240): identical to Phases 4 and 5 | yes |

## A. The two Phase 5 caveats

**A1. Twin divergence.** Kept the honest 5-minute window. `server/scenarios.ts` and `server/demo-check.ts` now say why: "cascade stages take ~4 min to propagate; 3-minute divergence is unrealistic given the sim's lag distributions". Measured on test-twin-5221: pre-split max |dP| 0, first |dP| > 0.1 at 13:00 (4 minutes after the 09:00 split), max |dP| within 5 minutes **0.639**. The task message said 0.064; the real number is 0.639 (P(cascade) 0.61 vs 0.18 at 13:00). The demo script narrates through the wait.

**A2. DEGRADED threshold.** It was already a config knob: `FILTER_KNOBS.degraded_below_coverage = 0.5` in `config/knobs.ts`, unchanged (eval integrity). What changed is how the demo asks for 0.8. In Phase 5 the server looked the episode up in the scenario list and applied 0.8 silently. Now:

- `/api/replay` takes `?degraded_threshold=<0..1>` (bad values are a 400). Without it, the engine default applies.
- The dashboard sends `&degraded_threshold=0.8` only for the Cutout scenario (its `degradedBelow` in `server/scenarios.ts`).
- Opening the same cutout episode without the parameter shows no banner (tested), so nothing about the demo threshold is hidden.
- The banner still says "demo threshold: below 80% trust-weighted coverage; engine default 50%".
- README says: "The demo cutout scenario uses an elevated DEGRADED threshold (80%) to demonstrate the banner; the eval uses the default (50%)", and LIMITATIONS item 9 covers calibration.

## B-D. Docs

- `README.md` rewritten: header, Quick Start, ASCII architecture with one sentence per component and the `engine/` never imports `sim/` firewall, the 3 concepts, the eval table and key numbers, the 6 scenarios, the commands reference, LIMITATIONS (10 items) and requirements.
- `docs/demo-script.md`: the timed 3-minute script, with every example figure replaced by what the dashboard shows. There is a table at the end listing what changed.
- `docs/demo-backup.md`: how to record `docs/demo-recording.mp4` (gitignored), and the smoke test right before presenting.

### Example figures replaced in the demo script

| Draft said | Real | Source |
|---|---|---|
| twin: "drainage anomalies in new zones" | hospital reports in z06 drive the 13:00 split | Twin A "Why it changed" at 13:00 |
| twin: "ESCALATE on the left, WATCH on the right" | left ALERT 14:00 / ESCALATE 16:00; right stays PREPARE all episode | replay |
| twin: "within a minute" | first dP > 0.1 at 4 min after the split | demo-check |
| gateway: "28 sensors" | 26 (27 a minute later) | evidence unit text |
| gateway: "G3" | gw0 | evidence unit text |
| gateway panel text | "P(sensor_failure) rose from 0.14 to 0.73 because identical readings from gateway gw0 arrived in z02." | minute 6 |
| prior shift: "starts at episode 50" | episode 51 (1-50 normal, 51-100 monsoon) | eval output |
| prior shift: "detects the regime change" | the prior moves (0.06 → 0.22) but CUSUM does not alarm on this sequence | eval output |
| "first 9 minutes", "35% to 2.5%", "0.72 to 0.41", "cost by 66%" | kept: all correct (split 09:00; 34.8% → 2.5%; 0.724 → 0.414; 1 - 2.62/7.73 = 66.1%) | eval output |

## E. Final eval captures (committed)

`.gitignore` now ignores `data/*` except `data/final-eval-*.txt`. Absolute paths in the "saved ..." line were made relative.

```
npm run eval -- --split test --policy engine           > data/final-eval-engine.txt           (76 lines)
npm run eval -- --split test --policy count-threshold  > data/final-eval-count-threshold.txt  (38 lines)
npm run eval -- --split test --policy always-watch     > data/final-eval-always-watch.txt     (38 lines)
npm run eval -- --split prior-shift --policy engine    > data/final-eval-prior-shift.txt      (46 lines)
```

Engine policy, final run (from `data/final-eval-engine.txt`):

```
Policy: engine   split: test   episodes: 302   ticks: 13038
  Brier score (mean per episode, 0 best, 2 worst)  0.414
  Log-loss (mean per episode)                      0.747
  Cost per tick (mean of per-episode cost/ticks)   2.62
  Mean lead time vs critical time (min)            -6.17   (88/88 cascades reached ALERT+)
  False-alarm rate (benign episodes with ALERT+)   2.5%   (4/158)
  Fallback ticks                                   0
  DEGRADED ticks                                   0   (0 episodes)
  Forecast accuracy (cascades: real event in window) 80.0%

policy            Brier LogLoss Cost/tick FalseAlarm Lead(min) Flips Fallback Forecast
always-watch      0.797   1.493     44.86       0.0%         -     0        0        -
count-threshold   0.724   1.324      7.73      34.8%     -3.88   589        0        -
engine-handset    0.427   0.767      2.63       2.5%     -6.40   244        0    80.0%
engine            0.414   0.747      2.62       2.5%     -6.17   240        0    80.0%
```

Prior-shift (from `data/final-eval-prior-shift.txt`): Brier 51-100 adaptive 0.401 vs static 0.397, CUSUM alarms: none. Unchanged from Phase 4.

The test split was evaluated again here (now 3 disclosed test runs in total, plus Phase 5's dashboard reads). Nothing was tuned or changed after any of them.

## F. Clean-state sequence

Run twice: once in the working tree (`rm -rf node_modules data` first), and once from a fresh `git clone` of the phase 6 commit into an empty directory:

```
npm ci                                   # found 0 vulnerabilities
npm run sim -- --build                   # dev 302, test 302, prior-shift 100
npm run eval -- --split test --policy engine   (+ count-threshold, always-watch, prior-shift)
npx tsc --noEmit                         # exit 0
npm test                                 # 19 files, 121 passed
npm run demo-check                       # all 6 demo scenarios pass
```

## G. New tests (`tests/phase6.test.ts`, 9)

1. Default DEGRADED threshold is 0.5 and the Cutout scenario asks for 0.8.
2. At 0.8, DEGRADED fires on test-cutout-5234; at the default it does not.
3. `/api/replay ... &degraded_threshold=0.8` streams degraded ticks and reports threshold 0.8; with no parameter it reports 0.5 and has none.
4. A bad `degraded_threshold` returns 400.
5. The four `data/final-eval-*.txt` exist and are non-empty.
6. The engine capture shows the frozen numbers (engine 0.414 / 0.747 / 2.62 / 2.5%, count-threshold 0.724 / 34.8%, always-watch 0.797).
7. `docs/demo-script.md` and `docs/demo-backup.md` exist.
8. README has a `## LIMITATIONS` section with at least 8 numbered items.
9. `engine/`, `config/`, `sim/`, `eval/` unchanged since c3b986e.

## Dashboard landing page (`npm run dev`, http://localhost:3000)

Dark theme. Top bar: "The First 10 Minutes", the scenario picker set to **Real Cascade**, speed 1x / 2x / **4x** (selected), Play / Pause / Step / Reset, a 00:00 clock, the mode tabs **Single** (selected) / Twin / Prior-Shift / Eval, and a Light / Dark toggle. Under it is the scenario description ("Real Cascade: Rain, drainage, traffic, calls, hospitals, power. P(cascade) stays at or below 0.12 for 12 minutes; ..."). The panels are still empty and waiting for Play: Belief now (four bars), Recommended action ("–", expected cost –), Belief timeline (0-45 min axis with the legend), Forecast ("No forecast yet."), Why it changed ("Press Play."), Event feed, and a collapsed Source trust. The footer lists the keyboard keys. Screenshot: project files `phase-reports/phase-6-screens/landing.png`; Cutout mid-run with the DEGRADED banner: `cutout.png`.

## Assumptions

1. **The four eval files** are engine / count-threshold / always-watch on test plus engine on prior-shift. The file list in the task message did not come through, so I picked the three policies of the README comparison table plus the prior-shift run.
2. **The DEGRADED value 0.8 stays in `server/scenarios.ts`** (the scenario's `degradedBelow`), which the dashboard sends as the query parameter. `config/knobs.ts` is untouched: its 0.5 default already was the configurable knob, so the knob-diff gate is literally empty.
3. **Node requirement is 22.12+, not 18+.** The pinned vitest 5 and tsx need it, and only Node 22.22 was tested. The README says so rather than promising 18.
4. **LIMITATIONS has 10 items**: the message said "all 8" but listed 10, so all 10 are in.
5. **Limitation 10 is reworded.** It says CUSUM does *not* alarm on the committed prior-shift sequence (it did on 9 of 10 dev-seeded copies), instead of "detects regime changes".
6. **"~300 events/episode"** is written as ~235 real events + ~950 heartbeats, ~180 sources (the measured numbers).
7. **The gate's `config/graph.ts`** is `config/causal-graph.ts` in this repo. All of `config/` is unchanged anyway.
8. The scenario label "Gateway Outage + Rumor Wave" is kept as in Phase 5 (a freeze). The episode is really a *lying* gateway, and the script says so.
9. **Commit and push** go to `claude/project-thread-0n9xmi` as one commit, so `git log --oneline -6` shows phases 1-6 (the phase 0 commit and the phase 0 docs commit fall just outside the 6).
