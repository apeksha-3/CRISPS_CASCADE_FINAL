# Phase 7 report: real NYC data, fetch, adapt, replay

Branch `phase-7-real-data`. The engine, config, sim and eval are untouched: `git diff d84a71c -- engine config sim eval` prints **0 bytes** (a test checks it). No retuning on real data. No injected variants were built.

## Gate summary

| Gate item | Result |
|---|---|
| Tests | **156/156** (127 existing + 29 new in `tests/real-phase7.test.ts`), `tsc --noEmit` clean |
| Empty diff on engine, config, sim, eval | yes (0 bytes against the Phase 6 freeze `d84a71c`) |
| Row counts per dataset per window | table below; `data/real/MANIFEST.md` lists 120 raw files with query, rows, SHA-256 |
| Ida timeline verdict | below |
| Real-episode eval, three policies | below, plus `data/real-eval-*.txt` |
| Episode counts per class | below |
| Two identical runs from cache | below |

A bug found and fixed during the gate: the DOT `id` column is not unique per report (it repeats for each link), so my first adapter produced duplicate event ids and the engine's log silently dropped most traffic heartbeats and slowdowns. Ids are now link + timestamp, and two tests (one fixture, one on every built episode) check ids are unique. All numbers in this report are from after the fix.

## B. Rows per dataset per window

Windows are local dates. "311" holds only the flooding, drainage, water and electric complaint types. EMS rows start 4 hours before the window (a hospital arrival can come hours after the call). `iem-rain` rows are 1-minute rows for 3 stations (gaps are real: ASOS 1-minute data is not complete). `isd-hourly` is the cross-check only.

```
rows per dataset per window
window                     311  dot-speeds  collisions         ems    iem-rain  isd-hourly
ida-2021                  7214      147146        1347       17311       11594         450
flood-2023                3782      145869        1166       18691       16795         528
rain-2022-07-18            933       36576         303        5507        3973           -
rain-2022-10-04            454       35712         270        4884        4320           -
rain-2022-12-23            896       35301         311        5579        4320           -
rain-2023-08-16            425       36862         261        5525        4297           -
rain-2023-09-11            606       36864         294        5732        3604           -
rain-2023-09-18            409       36819         280        5150        4202           -
rain-2023-11-22            372       35398         295        5229        2880           -
rain-2023-12-18            697       34940         297        5652        2074           -
dry-2022-01-13             507       32218         268        5152        4320           -
dry-2022-02-16             280       33352         278        4671        4313           -
dry-2022-03-22             268       35875         290        4667        4160           -
dry-2022-04-28             255       35540         348        4745        4320           -
dry-2022-06-29             381       36068         304        5538        4227           -
dry-2022-07-12             416       36576         267        5390        2894           -
dry-2022-07-20            1174       36576         290        5805        4320           -
dry-2022-09-21             328       35216         335        5387        4219           -
dry-2022-11-03             290       35424         318        5577        3847           -
dry-2022-12-14             284       35424         261        5456        2880           -
```

Schema facts that differ from the brief (found in step A and handled): the 311 complaint types are `Sewer` (descriptors Street Flooding, Catch Basin, Sewer Backup, Manhole Overflow...), `Water System` (Excessive Water In Basement) and `ELECTRIC` (upper case, an HPD building complaint); there is no complaint type named "Catch Basin", "Street Flooding" or "Flooded Basement". The syndromic dataset `2nwr-zzis` does not exist (404) and was dropped as decided. DOT `status` -101 means "no valid reading" (speed 0.00); those rows are treated as silence. Speeds are numeric strings; non-numeric ones are rejected and counted.

Control days (rules in `real/params.ts`, `real/select.ts`, result in `docs/real-zones.md`, chosen BEFORE the cascade windows were fetched): 8 rain days (KNYC 1.0 to 2.5 in, weekday, no NWS flash flood emergency for NYC, DOT data present), 10 dry days (Tue-Thu, zero rain at 3 stations, spread over 2022). Whole days are missing from the DOT dataset (for example 2022-05-31), so a day needs 20,000 DOT rows. Two dry targets needed a wider search (30 days), so summer has 3 dry days.

Zones (the 10 community districts with the most 311 volume on the dry days): mn12, bx04, bk01, qn05, bx07, bk05, qn12, qn01, bx05, mn10. Honest note: step A had already counted Ida-week rows and looked at one Ida night's 311 complaint types before the zone rule ran. That used volumes, not zones, and no zone rule depends on it.

## C. Adapters

Every mapping is documented at the top of its file in `real/`. Summary:

| Source | Engine source type | Kind | Severity | Notes |
|---|---|---|---|---|
| 311 Sewer street/highway flooding, Water System basement flooding | citizen_report (`cit-<zone>`, one per community board) | citizen_report ("flood report") | none (311 has none) | text is only the category |
| 311 Sewer catch basin, manhole overflow, sewer backup, culvert | citizen_report | drainage_anomaly | none | |
| 311 ELECTRIC | utility (`utl-<zone>`) | power_comms_load | none | WEAK PROXY: building wiring, not grid load |
| DOT speed | traffic_sensor (`trf-<link>`, behind a synthetic gateway) | heartbeat per valid report; traffic_slowdown below 60% of that link's dry-day baseline for that hour | 1 - speed/baseline, clipped | invalid reports are silence |
| EMS calls | dispatch (`dsp-<zone>`) | emergency_call_spike: 10-minute count >= 4 and > mean + 3 sqrt(mean) of the dry-day baseline | (9 - code)/8 | |
| EMS first hospital arrival | hospital (`hsp-<zone>`) | hospital_arrivals_unusual: 30-minute count >= 3 and > mean + 3 sqrt(mean) | 1 - mean/n | placed in the incident's district, not the hospital's |
| NYPD collisions | traffic_sensor (`col-<zone>`) | traffic_slowdown (the simulator's "accident" shape) | 0.3 / 0.6 / 0.9 (assumed table) | |
| IEM rain | rain_gauge (`rain-nyc/jfk/lga`) | heartbeat per 5-minute report; rain_heavy at >= 7.6 mm/h | mm/h / 50, clipped | bucket needs 3 valid minutes |

Arrival delay: `arrived_at = occurred_at + delay` with the simulator's delay model copied into `real/params.ts` (no import of `sim/`; only `import type` of the Episode shape), seeded by episode id and event id. Unmapped rows are counted by reason in `real/unmapped.json` (largest: 103,735 EMS rows outside the 10 zones; 18,981 DOT rows on links outside every zone; 3,332 DOT rows with no valid reading).

Baselines come from dry control days only. A dry episode's own day is left out of its baseline (leave-one-day-out). Cascade and rain episodes use all 10 dry days.

## D. Episodes and labels

`real/labels.json` is hand-written. Ida: CASCADING_CRISIS, onset 2021-09-01 21:28 EDT (NWS flash flood emergency for NYC, product WGUS51 KOKX 020128, from the IEM archive), critical time 22:45 (amNY, every subway line suspended as of 10:45 p.m.), each with a URL and a confidence note. The 29 Sep 2023 flood: CASCADING_CRISIS, onset and critical time **null** (no flash flood emergency was issued; the 11:14 a.m. subway suspension was partial), episodes are anchored on the heaviest 60 minutes of rain, which is stated as a data-derived anchor and not an onset. Rain controls: NOISE with `lookalike_type: rain_only`. Dry days: NOISE. **SENSOR_FAILURE and ISOLATED_INCIDENT are empty** (nothing with a citable source), and no injected variants exist.

| Class | Episodes | Independent events | Flag |
|---|---|---|---|
| cascade (CASCADING_CRISIS) | 6 | 2 | **not statistically meaningful** (2 events; the 3 offsets of one event are not independent) |
| lookalike:rain_only (NOISE) | 8 | 8 days | ok as a count, but all are heavy-rain days chosen by one rule |
| noise (NOISE) | 20 | 10 days | ok as a count (2 episodes per day are correlated) |
| SENSOR_FAILURE | 0 | 0 | **empty** |
| ISOLATED_INCIDENT | 0 | 0 | **empty** |

The eval runs null stage times without crashing: the 2023 episodes have no onset or critical time and no episode has stage times, so forecast start accuracy is 0 and lead time is undefined (tested with a fixture and with the built episodes). One quirk of the unchanged eval: its "N/6 cascades reached ALERT+" line counts only cascades with a critical time, so an ALERT in a 2023 episode (null critical time) is not counted there. The ALERT+ column is the one to read.

## E. Ida timeline (`docs/real-ida-timeline.html`)

Per 5 minutes, 16:00 to 24:00 local, Ida against the heaviest rain-control day and one dry day. Two thresholds per signal: "above control max" (higher than that signal's value in the same hours on any of the 18 control days, 2 of 3 bins; strict, because evening-rush control days are busy) and "above own first-4h level" (mean + 3 sd of the first 4 hours of the same day).

```
Ida 2021-09-01, 16:00-24:00 local, first elevated bin per signal
  rain mm/h (max of 3 stations)    threshold    7.6   first above control max 18:15   first above own first-4h level 18:15   peak 143.3 at 21:50
  311 flood + drainage reports     threshold    4.0   first above control max 22:05   first above own first-4h level 21:15   peak 13.0 at 23:35
  traffic slowdowns (events)       threshold   27.0   first above control max never   first above own first-4h level 21:40   peak 22.0 at 21:40
  EMS calls (raw incidents)        threshold   11.0   first above control max never   first above own first-4h level never   peak 10.0 at 17:40
  hospital arrivals (raw)          threshold    9.0   first above control max never   first above own first-4h level never   peak 7.0 at 19:20
order: rain mm/h 18:15 -> 311 flood + drainage reports 22:05

flood 2023-09-29, 04:00-12:00 local
  rain mm/h (max of 3 stations)    threshold    7.6   first above control max 06:00   first above own first-4h level 06:00   peak 100.6 at 09:10
  311 flood + drainage reports     threshold    4.0   first above control max 09:05   first above own first-4h level 08:25   peak 15.0 at 09:20
  traffic slowdowns (events)       threshold   25.0   first above control max 09:15   first above own first-4h level 09:00   peak 27.0 at 09:15
  EMS calls (raw incidents)        threshold   13.0   first above control max never   first above own first-4h level 08:05   peak 9.0 at 08:10
  hospital arrivals (raw)          threshold    9.0   first above control max never   first above own first-4h level never   peak 9.0 at 11:05
```

First hourly rain rates (IEM): 25 mm/h at 20:20 (JFK), 50 mm/h at 21:25 (LGA), 100 mm/h at 21:40 (LGA).

**Verdict, Ida.** The chain shows up only partly. Rain comes first and is extreme (peak 143 mm/h, 5-minute rate). Traffic slowdowns rise about 15 minutes after the 50 mm/h line (21:40; peak 22 per 5 minutes) but never exceed the strict control maximum (27). 311 flood and drainage reports rise next: above the control maximum at 22:05, about 40 minutes after 50 mm/h, and keep climbing past midnight (peak 13 per 5 minutes at 23:35). **EMS calls and hospital arrivals in these 10 zones show no rise at all** (peaks 10 and 7 per 5 minutes, inside the normal range). So rain, then traffic, then 311 appear in order with plausible lags (minutes, then tens of minutes); the EMS and hospital stages the engine's chain expects do not appear. 2023: rain 06:00 (100 mm/h at 09:15), 311 from 08:25 or 09:05, traffic 09:00 or 09:15, EMS above its own early level at 08:05 (weak, and before the rain peak), hospital never. Less clean than Ida. Two caveats: only 64 of 137 traffic links are in the zones, and the Central Park gauge is missing from IEM's 1-minute feed during the Ida peak.

ISD cross-check (`npm run real:crosscheck`; hours with at least 50 IEM minutes):

```
ida-2021
station  hourly reports  ISD total mm  IEM total mm  ratio  correlation  largest hourly gap mm
NYC                  31           0.0           0.0    NaN          NaN                    0.0
JFK                  74          70.5          69.6   0.99        0.991                    2.3
LGA                  73         175.2         175.0   1.00        0.969                   15.0

flood-2023
station  hourly reports  ISD total mm  IEM total mm  ratio  correlation  largest hourly gap mm
NYC                  88         149.9         149.9   1.00        0.991                    5.8
JFK                  92         225.8         225.8   1.00        0.993                    4.3
LGA                  91         125.9         126.0   1.00        0.992                    3.3
```

JFK and LGA agree with ISD to within 1% in total (correlation 0.97 to 0.99); in 2023 all three stations do. KNYC on Ida has no comparable hours because IEM has no 1-minute rows for the storm hours (ISD reports 88 mm in the hour ending 01:51 UTC, 21:51 EDT).

## F. Replay: `npm run eval -- --split real --policy engine|count-threshold|always-watch`

Output files: `data/real-eval-engine.txt` (with the policy comparison, trust panel), `-count-threshold.txt`, `-always-watch.txt`.

```
policy            Brier LogLoss Cost/tick FalseAlarm Lead(min) Flips Fallback Forecast
always-watch      0.434   0.899     12.34       0.0%         -     0        0        -
count-threshold   0.344   0.779     11.23       0.0%     58.00     6        0        -
engine-handset    0.773   1.464      7.96       0.0%         -    33        0     0.0%
engine            0.779   1.460      7.56       0.0%         -    32        0     0.0%

group                        n     truth  Brier LogLoss Cost/tick  ALERT+ Lead(min) Flips      (engine)
cascade                      6      CASC  1.347   3.242     39.67    0.0%         -     7
lookalike:rain_only          8     NOISE  0.715   1.155      0.60    0.0%         -     7
noise                       20     NOISE  0.634   1.047      0.72    0.0%         -    18
```

Per-episode actions in every real cascade episode (`npm run real:actions -- engine`; learning order identical to the harness):

| Episode | Engine actions (episode minutes) | max P(cascade) | count-threshold actions |
|---|---|---|---|
| real-ida-2021-on10 (onset min 10, critical min 87) | WATCH 1, PREPARE 2-28, WATCH 29-45 | 0.104 | WATCH 1-28, **ALERT 29-30**, PREPARE 31-33, WATCH 34-45 (lead 58 min) |
| real-ida-2021-on20 (onset 20, critical 97) | WATCH 1, PREPARE 2-23, WATCH 24-28, PREPARE 29-32, WATCH 33-45 | 0.100 | WATCH 1-38, **ALERT 39-40**, PREPARE 41-43, WATCH 44-45 (lead 58 min) |
| real-ida-2021-on30 (onset 30, critical 107) | WATCH 1, PREPARE 2-23, WATCH 24-45 | 0.083 | WATCH 1-45 |
| real-flood-2023-on10 (no onset, no critical) | WATCH 1, PREPARE 2-45 | 0.101 | WATCH 1-38, PREPARE 39-41, **ALERT 42**, PREPARE 43-44, **ALERT 45** (lead undefined) |
| real-flood-2023-on20 | WATCH 1, PREPARE 2-45 | 0.087 | WATCH 1-45 |
| real-flood-2023-on30 | WATCH 1, PREPARE 2-24, WATCH 25-29, PREPARE 30-45 | 0.076 | WATCH 1-45 |

Plain reading: the engine never moves above PREPARE and its P(cascade) falls from about 0.10 to about 0.02 to 0.05 during every cascade episode. The simple count-threshold baseline raised ALERT in 3 of 6 cascade episodes (2 of them 58 minutes before the labelled critical time) and has no false alarm. The engine's lower cost per tick (7.56 vs 11.23) comes from hovering at PREPARE, which is cheap when a cascade is possible; it is not evidence of detection. 2 events cannot support a ranking of the policies.

## G. Tests (29 new)

UTC to local with known pairs (Ida EDT, winter EST, the March clock change); control-day rules on fixtures; zone, neighbour and gateway helpers; each adapter on fixtures including the unmapped counters; unique DOT event ids; delay determinism; baselines use dry days only (fixture cache, the cascade file is never read) and leave-one-day-out; engine imports nothing from `sim/`, `eval/` or `real/` (static, dynamic, require); `real/` imports `sim/` only with `import type`; engine, config, sim, eval byte-identical to `d84a71c`; labels cite URLs and no invented classes; the eval runs episodes with null stage times; and, from the cache, every built event validates against the Event type with no hidden fields, gateways are marked synthetic, ids are unique, and rebuilding gives byte-identical episodes. The cache tests skip on a fresh clone before `real:fetch`.

## Two identical runs from cache

Run twice back to back (`npx tsx scripts/real/build.ts`, then `npm run eval -- --split real --policy engine`), hashes of the outputs:

```
run 1: episodes 34d42cd9a607d019  unmapped.json d77e705c2bb8caaf  eval output 45670f5c97f651b4
run 2: episodes 34d42cd9a607d019  unmapped.json d77e705c2bb8caaf  eval output 45670f5c97f651b4
```

## SANITY: engine on real data against the simulator

The engine was tuned on the simulator, so it should do worse on real data. It does:

| Engine | Simulator test split (302 episodes) | Real split (34 episodes) | Gap |
|---|---|---|---|
| Brier | 0.414 | 0.779 | +0.365 (nearly double) |
| False-alarm rate (benign episodes with ALERT+) | 2.5% (4/158) | 0.0% (0/28) | -2.5 points: **better, but only because the engine raised no ALERT at all** |
| Lead time vs critical time | -6.17 min, 88/88 cascades reached ALERT+ | none, 0/6 reached ALERT+ | no alert on any real cascade |
| Cost per tick | 2.62 | 7.56 | +4.94 |

By group: cascade Brier 0.474 vs 1.347; noise 0.157 vs 0.634; rain_only 0.183 vs 0.715. Two comparison policies moved the other way: count-threshold is 0.724 on the simulator and 0.344 on real data (it beats the engine on real Brier), always-watch 0.797 vs 0.434.

**Leakage check** (a number looks better on real data: the false-alarm rate). It is not leakage: it is the engine never alerting. Baselines and zone selection never use cascade or rain episodes; dry-day baselines are leave-one-day-out; the only overlap is that the dry days' 311 volume helped choose the zones (no label information), which can affect how many 311 reports a zone has, not which episode is a cascade.

**Likely causes, ranked by an ablation run on the built episodes (analysis only, nothing changed; fresh engine per episode, no between-episode learning, 6 cascades and 28 noise episodes):**

| Variant | cascade Brier | noise Brier | end P(NOISE / SENSOR / ISOLATED / CASCADE), cascades |
|---|---|---|---|
| as built | 1.338 | 0.730 | 0.21 / **0.50** / 0.27 / 0.03 |
| remove dead links from the registry | 1.387 | 0.562 | 0.33 / 0.05 / **0.59** / 0.03 |
| remove 311 ELECTRIC | 1.335 | 0.721 | 0.22 / 0.49 / 0.27 / 0.03 |
| remove collisions | 1.331 | 0.726 | 0.22 / 0.52 / 0.23 / 0.03 |
| remove all traffic slowdowns | 1.355 | 0.644 | 0.18 / 0.74 / 0.06 / 0.03 |

1. **Chronically dead sources read as sensor failure.** 8 to 14 of the 64 DOT links report no valid reading for the whole 45 minutes, in every episode, normal or not (8 on the dry evening checked, 11 to 14 on Ida and 2023). The simulator's sensors are alive unless an outage is injected, so the engine takes silence as SENSOR_FAILURE: P(sensor failure) is about 0.5 to 0.6 in nearly every real episode. Removing the dead links drops it to 0.05 to 0.09 (and noise Brier from 0.73 to 0.56). This is the single largest effect.
2. **A noisy traffic detector looks like an isolated incident.** Once the dead links are gone, about 10 to 210 traffic slowdowns per episode (more in rush hour and in the cascades) (a per-link rule at 60% of the hourly mean, noisy in rush hour) push P(isolated incident) to about 0.6, because the simulator's traffic-alone pattern means "an accident". This is also why cascades never rise: the evidence the engine reads as cascade-like (chained drainage, calls, hospitals) is mostly absent.
3. **The expected chain is not in the data.** On Ida, EMS calls and hospital arrivals in the 10 zones show no rise, and the lags that do exist are tens of minutes (311 about 40 minutes after heavy rain), while the engine's learned lags are 2 to 3 minutes per stage (`config/lags.ts`) and its evidence window is short. The cascade posterior has nothing to climb on, and the critical times sit 87 to 107 minutes into episodes that last 45.
4. **Trust learned the wrong lesson.** Across the 34 episodes the engine's between-episode learning lowers trust in traffic sensors (mean 0.16) and citizen channels (0.32), because most of their events fall in NOISE episodes. With 2 cascade events, that is what the data teaches.
5. **Minor:** 311 carries no severity and ELECTRIC is a weak proxy (removing it changes Brier by about 0.01); collisions are a small effect.

Nothing here was fixed, as instructed. What would be done next (not done): treat chronically silent links as absent at registration, set severity and lags from real data, and add more real events.

## H. Housekeeping

README has a "Real data" section (real, synthetic, manual) and LIMITATIONS 11 to 16; limitation 1 now points to them. New npm scripts: `real:fetch`, `real:build`, `real:plot`, `real:actions`, `real:crosscheck`. `.gitignore` lets `data/real/MANIFEST.md` and `data/real-eval-*.txt` through; the 300 MB raw cache and built episodes stay ignored. Run `real:fetch` before `real:build`; run the real eval before any dev or test eval if you want to avoid the harness's "Dev/test agreement" block, which would label real numbers as "test".
