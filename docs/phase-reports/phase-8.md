# Phase 8 report: real-data hardening

Branch `phase-8-real-hardening`, from `phase-7-real-data` head `2e3f608`. The engine, config, sim and eval are untouched (`git diff d84a71c -- engine config sim eval` is 0 bytes, and a test checks it). The simulator-tuned config is frozen. Nothing was retuned: every replay below uses the engine as it was. Step F was not built (reason at the end). I did not merge anything into `main`.

## Gate summary

| Gate item | Result |
|---|---|
| Tests | **166/166** (127 existing + 29 from Phase 7 + 10 new in `tests/real-phase8.test.ts`), `tsc --noEmit` clean |
| Frozen diff (engine, sim, config, eval) | empty (0 bytes against `d84a71c`) |
| Step A before/after | below: Brier 0.777 to 0.536, mean P(sensor failure) 0.354 to 0.151, **still 0 alerts on real cascades** |
| Citywide EMS and hospital plot with verdict | `docs/real-ems-citywide.html`, verdict below |
| Event list with sources | `docs/real-events.md` (64 NWS events, rain ranking, 10 events used) |
| Lag table | below (and `data/real-eval-p8-lags.txt`) |
| Per-event results | below (and `data/real-eval-p8-replay-loeo.txt`) |
| Two identical runs from cache | below |

**A correction to Phase 7, found in this phase.** NYC changed its 311 category names. In September 2023 the old `Sewer` and the new `Sewer Maintenance` (and `Water System` / `Water Maintenance`) were both in use, and from early 2026 only the new names are. The Phase 7 fetch asked only for the old names, so it missed about 40% of the flooding reports on 29 Sep 2023 (3,782 rows then, 6,246 now) and nearly all of them in 2026. The fetch and the 311 adapter now handle both spellings (`real/fetchwin.ts`, `real/adapt-311.ts`, tested). Every number in this report uses the corrected 311 data. For the Phase 7 episode set the correction moves the engine's Brier from 0.779 (as published) to 0.777.

## A. Registry fix

Rule (adapter only, `real/baselines.ts healthyLinks`, `LINK_HEALTH` in `real/params.ts`): a DOT link is registered only if, on at least **70%** of the dry control days, it sent at least **144 valid reports** (half of a full day's ~288). For a dry episode its own day is left out (leave-one-day-out), as the baselines are. Of the 64 zone-mapped links, **53 are registered and 11 are not**. Unregistered links' rows are counted in `real/unmapped.json`, not used.

Same 34 Phase 7 episodes, same engine, 311 fix in both arms. Harness mode (one shuffled sequence with learning between episodes, exactly as `npm run eval -- --split real`):

| | Phase 7 as published | ARM 1: all links (311 fixed) | ARM 2: healthy links only |
|---|---|---|---|
| Engine Brier | 0.779 | 0.777 | **0.536** |
| Engine cost per tick | 7.56 | 7.45 | 4.03 |
| Mean P(sensor failure), all episodes | 0.362 | 0.354 | **0.151** |
| Brier, noise episodes (20) | 0.634 | 0.632 | 0.324 |
| Brier, cascade episodes (6) | 1.347 | 1.345 | 1.334 |
| False-alarm rate | 0.0% | 0.0% | 0.0% |
| Cascade episodes reaching ALERT | 0/6 | 0/6 | **0/6** |
| Max P(cascade) on cascades | 0.092 | 0.092 | 0.094 |

Leave-one-event-out learning (engine / engine-frozen): all links 0.768 / 0.841, healthy links **0.489 / 0.694**.

**Reading.** The registry fix is real and large: about two thirds of the Brier gap between real data (0.777) and the simulator (0.414) closes (0.777 to 0.536, or to 0.489 without within-event learning). It all comes from the noise episodes, where P(sensor failure) falls from 0.375 to 0.142. **It changes nothing on the cascades**: Brier 1.345 to 1.334, no ALERT, max P(cascade) 0.094, which is below the 0.10 base rate. So failure cause 1 explains the noise-side gap, not the missing detection. Detection is the finding below. Full output: `data/real-eval-p8-registry-ab.txt`.

## B. Citywide EMS and hospital check (no engine runs)

`docs/real-ems-citywide.html`, `data/real-eval-p8-citywide.txt`. Trailing 30-minute counts every 5 minutes against the same clock time on the 10 dry days (mean, sd). "Rises" = z of at least 3 in 2 consecutive bins.

| Event | Signal, scope | Peak (30-min count vs normal) | Rises? |
|---|---|---|---|
| Ida | EMS calls, citywide | 136 vs 82 (x1.65) at 23:45 | yes, but only from 23:25: about 2 hours after the 50 mm/h line (21:25) and 40 minutes after the subways shut |
| Ida | hospital arrivals, citywide | 79 vs 70 (x1.13) | **no** (and they fall below normal after 21:00) |
| Ida | calls / arrivals, 10 zones | x1.44 at 20:30 (before the storm peak) / x1.49 | calls "yes" at 20:30, which is before the storm: noise at small counts; arrivals no |
| 2023 flood | EMS calls, citywide | 92 vs 63 (x1.46) at 07:40 | yes, from 07:35 (about an hour after 25 mm/h at 06:35, before the 100 mm/h peak at 09:15) |
| 2023 flood | hospital arrivals, citywide | 100 vs 70 (x1.44) at 11:15 | **no** sustained rise (one bin at z 3.5, two hours after the rain peak) |
| 2023 flood | 10 zones | calls x1.84 (z 6.2, not 2 bins), arrivals x1.63 | no |

**Verdict.** The Phase 7 "no EMS or hospital rise" finding was partly a small-numbers problem in the 10 zones, but the citywide view does not rescue the chain. **EMS calls do rise citywide in both events, modestly (x1.5 to x1.65) and hours rather than minutes after the heavy rain. Hospital arrivals do not rise at all in a way that clears a 3 sd bar.** In Ida they fall below normal during the storm. The two late stages the engine's cascade fingerprint depends on are therefore weak or absent in real data.

## C. More real events

`docs/real-events.md` has the full tables. Method: every NWS Flash Flood Warning/Emergency product from the New York office (`FFWOKX`), 2019 to 2026-10, from the IEM archive, grouped into events that name a NYC county: **64 events**, only one with a flash flood emergency for NYC (Ida). Ranked by the heaviest 60 minutes of rain (IEM 1-minute data) and checked for DOT, EMS and 311 coverage on the event day and the next; 2019 events fail on 311 (no rows returned), and some days in 2020 and 2026 have partial DOT data. Taken heaviest first, using rain and coverage only: **10 events** (Ida and 2023 from Phase 7, plus 8 new).

| Event | Tier | Source for the label | Onset / critical |
|---|---|---|---|
| ida-2021 (1 Sep 2021) | cascade | NWS flash flood emergency 21:28 (IEM archive); MTA all lines suspended 22:45 (amNY) | 21:28 / 22:45 |
| flood-2023 (29 Sep 2023) | cascade | state of emergency, partial subway suspension (Time Out), IEM archive | null / null |
| flood-2025-07-14 | cascade | NWS flash flood warnings for all 5 boroughs (IEM archive); "MTA officials suspended several subway lines Monday night", Central Park 2.07 in in one hour (Time Out, 15 Jul 2025) | null / null |
| flood-2026-08-20 | ambiguous | NWS warning; NYC Emergency Management pre-event alert (no impact report found) | null / null |
| flood-2020-08-12, flood-2022-09-13, flood-2026-08-23, flood-2021-08-27, flood-2025-10-30, flood-2023-07-18 | ambiguous | NWS warning only (IEM archive) | null / null |

**Tier cascade** means a cited source shows an NYC-wide impact (flash flood emergency, emergency declaration, or flood-caused multi-line subway suspension): scored as CASCADING_CRISIS. **Tier ambiguous** means a flash flood warning with good data but no verified cascade-class impact: these are **not scored as cascade or noise**, only watched (`data/episodes/real-ambiguous/`, no truth label). I did not label them NOISE because a flash flood warning means flooding was a real possibility. Web search results were noisy (one summary mixed the 14 Jul and 31 Jul 2025 storms and a 30 Oct 2025 date); a claim is used only where a fetched page supports it.

Consistency note: 4 of the 8 Phase 7 rain-control days (2022-07-18, 2022-12-23, 2023-09-11, 2023-12-18) also had NWS flash flood warnings, so their NOISE label is weaker. They are reported as their own class `rain_only+FFW`.

**Events, not episodes.** Scored classes: cascade **3 events** (9 episodes, 3 offsets each, not independent); rain_only 4 events and rain_only+FFW 4 events; noise 10 days (20 episodes, 2 per day). SENSOR_FAILURE and ISOLATED_INCIDENT: 0, empty. Ambiguous: 7 events (21 episodes), unscored. **Every class except noise has fewer than 5 independent events: not statistically meaningful.** The Phase 8 events use the same rules as Phase 7 (heaviest-60-minute rain anchor, onset 10/20/30 minutes in, baselines from dry days) with the 2022 dry days as the baseline even for 2020, 2021, 2025 and 2026 events.

## D. Timescale: when does each stage rise after the heavy rain starts?

Table only; `scripts/real/lags.ts`, `data/real-eval-p8-lags.txt`. Minutes from the first 5-minute rain rate of 25 mm/h (the engine's "strong rain" line) to the first rise of a stage (z of at least 3 against the dry days, at least 1.25 times normal and at least 5 events, 2 consecutive 5-minute bins; the floors were set so a handful of reports does not count, and applied the same way to every event):

| Event | tier | 311 flood+drainage | traffic slowdowns | EMS calls | hospital arrivals |
|---|---|---|---|---|---|
| ida-2021 | cascade | -170 | +70 | +190 | no rise |
| flood-2023 | cascade | -80 | +65 | +20 | no rise |
| flood-2025-07-14 | cascade | +10 | +55 | no rise | no rise |
| flood-2026-08-20 | ambiguous | +15 | +60 | no rise | no rise |
| flood-2020-08-12 | ambiguous | -50 | no rise | no rise | no rise |
| flood-2022-09-13 | ambiguous | +265 | +65 | no rise | no rise |
| flood-2026-08-23 | ambiguous | +25 | -180 | -180 | no rise |
| flood-2021-08-27 | ambiguous | -40 | +180 | no rise | no rise |
| flood-2025-10-30 | ambiguous | -80 | +15 | no rise | no rise |
| flood-2023-07-18 | ambiguous | -30 | no rise | no rise | no rise |

| Stage | Engine config, cumulative minutes from rain (`config/lags.ts`) | Cascade events: rose in, mean, sd | All 10 events: rose in, mean, sd |
|---|---|---|---|
| 311 flood and drainage (engine: drainage) | 2.8 | 3 of 3, -80, 90 | 10 of 10, -14, 114 |
| traffic slowdowns | 4.7 | 3 of 3, +63, 8 | 8 of 10, +41, 101 |
| EMS calls | 6.6 | 2 of 3, +105, 120 | 3 of 10, +10, 185 |
| hospital arrivals | 9.1 | 0 of 3 | 0 of 10 |

Anchoring the same table on the first 50 mm/h bucket (the intense burst) shortens the cascade-event traffic lag to +15 minutes (sd 26) and the 311 lag to -128 (sd 119); the full table is in the capture.

**Reading.** Traffic is the one stage with a consistent lag: about an hour after the first 25 mm/h (cascade events +55 to +70, sd 8), or minutes to 45 minutes after the 50 mm/h burst, against the engine's 4.7 minutes. 311 reports rise before the rain reaches 25 mm/h in most events (negative lags, large spread), because lighter earlier rain already produces reports and the 311 baseline is near zero at night: a poor timing signal. EMS calls rise in only 3 of 10 events, hours later or inconsistently. **Hospital arrivals never rise in any of the 10 events.** The spread is as large as the means: with 3 cascade events the numbers are an indication, not an estimate.

## E. Replay and evaluation by event

Scored split: 37 episodes, 21 events. No policy is ever scored on an event it learned from: **leave-one-event-out** (`real/loeo.ts`, `scripts/real/replay.ts --mode loeo`). For each event a fresh policy learns trust from every other event's episodes, then plays the held-out event with learning off. The engine is also shown with no learning at all (`engine-frozen`). The old "harness" mode, where an episode can learn from the other offsets of its own flood, is in `data/real-eval-p8-replay-harness.txt` for comparison only. Nothing was tuned on any real event.

| Policy (leave-one-event-out) | Brier | Cost/tick | False alarms | Cascade episodes ALERT+ | mean P(sensor failure) | max P(cascade) on cascades |
|---|---|---|---|---|---|---|
| engine | 0.552 | 5.15 | 0.0% (0/28) | 0/9 | 0.178 | 0.101 |
| engine-frozen | 0.740 | 10.97 | 0.0% | 0/9 | 0.141 | 0.090 |
| count-threshold | 0.428 | 14.52 | 0.0% | 3/9 | 0.120 | 0.177 |
| always-watch | 0.494 | 15.39 | 0.0% | 0/9 | 0.150 | 0.100 |

Per cascade event (engine / count-threshold): ida-2021 Brier 1.31 / 1.38, max action PREPARE / ALERT in 2 of 3 episodes; flood-2023 1.36 / 1.35, PREPARE / ALERT in 1 of 3; flood-2025-07-14 1.27 / 1.40, PREPARE / WATCH. The engine's maximum P(cascade) is 0.11 in every event.

Per class (engine, Brier): cascade 1.315 (**3 events, not meaningful**), noise 0.283 (10 events), rain_only 0.463 (4 events, not meaningful), rain_only+FFW 0.266 (4 events, not meaningful). SENSOR_FAILURE and ISOLATED_INCIDENT: empty.

**Ambiguous events (21 episodes, 7 events, unscored; `data/real-eval-p8-ambiguous.txt`).** No policy raised ALERT on any of them except count-threshold on flood-2025-10-30 (ALERT in 3 of 3 episodes, max P 0.35). The engine's P(sensor failure) on these is 0.17 to 0.23 for the 2020 to 2023 events, **0.36 to 0.40 for 2025 and 0.55 to 0.57 for the two 2026 events**, even with the registry fix. The registry and baselines come from 2022 dry days, and the DOT link inventory evidently changed since: far from 2022, a registry built from 2022 marks working links as silent. A registry should be rebuilt from normal days near the date of use.

What the numbers support: "the engine never raises P(cascade) above its base rate on any real cascade or flood-warning event, across 10 events and 4 years" is solid at the level of 3 scored cascades plus 7 unscored events. "count-threshold beats the engine" is not: it alerted on 3 of 9 cascade episodes (2 events), each a burst of 1 to 2 minutes.

## Why the engine does not respond (inference from config and the lag table, not an ablation)

`config/likelihoods.ts` gives a cascade only small nudges for the early stages: rain +0.05, chained drainage +0.06, chained traffic +0.06, chained calls +0.15 nats per event. The big cascade evidence is late: chained hospital arrivals +0.9 and chained power +0.8. Real data supplies the early stages (rain, 311, traffic) but not the late ones: hospital arrivals rose in 0 of 10 events and EMS calls in 3 of 10, and the power signal is a weak proxy. So P(cascade) has nothing large to climb on, regardless of timing. That makes the timescale mismatch (engine 2 to 3 minutes per stage; real traffic about an hour, calls hours, hospitals never) a real gap but not the main one.

## F. Not built

Optional step F (a `real` lag profile in `config/`) only applies "if the timescale is the main remaining gap". It is not: rescaling lags cannot create the hospital and calls evidence that is missing from the real data (0 of 10 events for hospitals), and with 3 scored cascade events a leave-one-event-out fit would have 2 events to learn from. Nothing was added to `config/`.

## Two identical runs from cache

`scripts/real/build.ts`, `replay.ts --mode loeo --actions`, `lags.ts`, `citywide.ts` run twice back to back; hashes of the outputs:

```
run 1: episodes 26e2ea2000f2 ambiguous e80b2e5cd7bc replay 464f730ef816 lags 47ef4b5e6d1b citywide 756861d80e0f
run 2: episodes 26e2ea2000f2 ambiguous e80b2e5cd7bc replay 464f730ef816 lags 47ef4b5e6d1b citywide 756861d80e0f
```

## Files

New: `real/nws.ts`, `real/loeo.ts`, `real/events.ts`, `real/fetchwin.ts`, `real/labels-p8.json`, `real/candidates.json`, `real/ranking.json`, `scripts/real/{events-find,events-rank,events-doc,fetch8,replay,lags,citywide}.ts`, `tests/real-phase8.test.ts`, `docs/real-events.md`, `docs/real-ems-citywide.html`, `data/real/MANIFEST-phase8.md`, `data/real-eval-p8-*.txt`. Changed: the registry, baselines, DOT adapter and episode builder (the registry fix), the 311 adapter and fetch (2026 names), `.gitignore`, `README.md`, `CLAUDE.md` (rule 7 names the Phase 8 branch).
