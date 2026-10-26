# Phase 9 report: real-data impact nowcasting (offline ML, calibrated)

Branch `phase-9-nowcast`, from `phase-8-real-hardening` head `c8a6ce1`. The engine, config, sim and eval are untouched (`git diff c8a6ce1 -- engine config sim eval` is 0 bytes; the Phase 7 test against `d84a71c` also still passes). The model is **not wired into the engine** and nothing in `engine/`, `config/`, `sim/`, `eval/` or `server/` imports `ml/` (a test checks it). Python is used only to train (`scripts/ml/`, `requirements.txt`: numpy and scikit-learn); the runtime is one TypeScript function.

## Gate summary

| Gate item | Result |
|---|---|
| Frozen diff | empty |
| Tests | **187/187** (166 earlier + 21 new: 10 TypeScript-versus-Python inference tests, 11 data-set and leakage tests); `tsc --noEmit` clean |
| TS versus Python inference | identical to 1e-9 on 100 real test rows, for every model and both targets (`tests/nowcast.test.ts`) |
| Label definitions and positive rates | section B |
| Dataset sizes per split | section B (no split is thin: every one has at least 88 events) |
| 4 models on test with confidence intervals | section E |
| Reliability table | section E |
| Two identical runs from cache | section G |

## A. Diagnostic: where does the engine's cascade signal come from? (`data/real-eval-p9-llr.txt`)

Log-likelihood (nats) that the engine's evidence units add per hypothesis at the end of an episode, per episode, from the engine's own `units()`:

| kind | simulator cascades (40): CASC minus NOISE | real Ida (3 episodes): CASC minus NOISE |
|---|---|---|
| rain_heavy | +0.05 | +0.11 |
| drainage_anomaly | -0.93 | -0.36 |
| citizen_report | -0.02 | +0.05 |
| traffic_slowdown | -0.88 | **-2.24** (the same events add +2.82 to ISOLATED_INCIDENT) |
| emergency_call_spike | **+2.94** | no events |
| hospital_arrivals_unusual | **+11.57** | -0.11 (0.7 events) |
| power_comms_load | **+10.79** | 0.00 |
| total positive | 25.36 | 0.15 |

**Confirmed.** In the simulator, 100% of the positive cascade-over-noise evidence (25.3 nats) comes from the three late stages (calls, hospitals, power); the early stages are net negative. On Ida the late stages supply nothing and the one early kind with many events, traffic slowdowns, pushes the engine away from cascade and toward "isolated incident". The cascade signal cannot form from the stages real data does show.

## B. Labels from outcomes, and the data

No manual labels. A **tick** is a 5-minute bucket inside a rain period: the largest 30-minute rain total at KNYC, KJFK or KLGA is at least 1.0 mm. Ticks are grouped into rain **events** (a gap over 3 hours starts a new one); an event belongs to the split of its first tick, so none spans two splits. Data: IEM 1-minute rain (94 months, 2019-01 to a fixed end of 2026-10-20), 311 flood, drainage and water reports citywide (8 years; 2019 comes from the portal's archive dataset, 2020 on from the live one; **both category schemes**, old `Sewer`/`Water System` and new `Sewer Maintenance`/`Water Maintenance`, are handled), and DOT speeds as hourly per-link means aggregated by the portal (113 million raw rows are not fetchable; `data/real/MANIFEST-phase9.md`).

**Target 1, `y311`:** 1 if the citywide count of 311 flood and drainage reports in the NEXT 60 minutes exceeds the 99th percentile of the same quantity (the forward 60-minute count at each 5-minute tick of the same clock hour) on the preceding dry days, with a floor of 5 reports. The pool is the 60 most recent dry days of the same type (weekday or weekend) before the tick's day, at least 30 required. A dry day has at most 0.1 mm at every station, valid rain data for 80% of the day, and a dry day before it. Thresholds run from 5 to 41 reports, median 6.

**Target 2, `ytraffic`:** 1 if the share of healthy DOT links in slowdown (hourly mean below 60% of the link's own baseline for that clock hour) in the next full clock hour exceeds the 99th percentile of that hour of day on the preceding dry days (floor 10%). DOT is hourly here, so this is an hourly target and for a tick at 14:35 it refers to 15:00 to 16:00. It exists where DOT has data (84% of ticks have the feature).

**Features** (known at the tick only): rain now, 15/30/60-minute totals, peak intensity in the last hour, rain from 25 to 1 hours ago, clock hour and month (sine and cosine), 311 reports in the last 30 minutes (count and ratio to the dry-day mean) and the share of healthy links in slowdown in the last completed hour (0 plus a flag when missing). **Baselines and registry are rolling:** a link is healthy if on at least 70% of the 10 most recent same-type dry days it had at least 6 readings in at least 12 clock hours; its baseline is its mean hourly speed on those days. This replaces the 2022-only registry and fixes the 2025 and 2026 drift seen in Phase 8.

| split | events | ticks | y311 positive | traffic ticks | traffic positive |
|---|---|---|---|---|---|
| train (2019-2023) | 456 | 12,842 | 29.3% | 9,477 | 9.3% |
| validate (2024) | 102 | 2,547 | 37.6% | 2,106 | 4.6% |
| test (2025 to 2026-10-20) | 206 | 6,529 | 26.7% | 5,945 | 7.7% |
| all | 764 | 21,918 | 29.5% | 17,528 | 8.2% |

Traffic events per split: 356, 88, 197. Nothing is under 30 events. 2,650 early-2019 ticks were dropped because fewer than 30 preceding dry days existed (the data set effectively starts in spring 2019). 1,506 dry days were found.

## D. Models

All four are fitted on train only. (1) Climatology: the training positive rate. (2) Rule: "rain intensity now at or above a threshold", two probabilities from train, threshold chosen on validation (8 mm/h for 311, 1 mm/h for traffic). (3) Logistic regression, L2, C chosen on validation. (4) Gradient-boosted trees (scikit-learn; 100 trees of depth 4 for 311, 50 of depth 2 for traffic, chosen on validation). Logistic and GBT are **Platt-calibrated on validation only** and exported as JSON (`ml/models/nowcast-311.json`, `nowcast-traffic.json`); `ml/nowcast.ts` runs them. `train.py` checks that the exported GBT reproduces scikit-learn to 1e-9 before writing it.

Two **extra baselines, not in your list of four**, are reported next to them so the comparison is fair: a *persistence rule* (a single threshold on the target's own recent activity: the 311 ratio, or the slowdown share last hour) and a *rain-only GBT* (rain and clock features, no 311, no DOT).

## E. Test results (2025 to 2026-10-20), bootstrap 95% intervals over whole events

**Target 311: 6,529 ticks, 206 events, 26.7% positive.**

```
model           Brier            95% CI  log-loss            95% CI    AUC          95% CI    ECE          95% CI
climatology    0.1966    [0.166, 0.232]    0.5823    [0.518, 0.658]  0.500  [0.500, 0.500]  0.025  [0.002, 0.101]
rule           0.2004    [0.175, 0.230]    0.5889    [0.532, 0.654]  0.552  [0.519, 0.588]  0.049  [0.031, 0.109]
logistic       0.1758    [0.128, 0.225]    0.5616    [0.405, 0.736]  0.827  [0.771, 0.887]  0.150  [0.059, 0.232]
gbt            0.1305    [0.111, 0.147]    0.4076    [0.358, 0.452]  0.865  [0.828, 0.902]  0.098  [0.034, 0.160]
persistence    0.1210    [0.097, 0.149]    0.4100    [0.354, 0.476]  0.768  [0.732, 0.805]  0.058  [0.031, 0.093]
gbt_rain       0.3262    [0.223, 0.411]    1.1298    [0.708, 1.476]  0.601  [0.496, 0.737]  0.257  [0.133, 0.369]
```

Paired differences (negative Brier or log-loss, positive AUC = the first model is better), interval over events, share of replicates where it is better:

```
  logistic  vs climatology brier -0.0207 [-0.0935, +0.0498] (73%)  logloss -0.0206 [-0.2307, +0.1923] (60%)  auc +0.3269 [+0.2707, +0.3871] (100%)  ece +0.1249 [+0.0026, +0.1634] (2%)
  logistic  vs rule        brier -0.0246 [-0.0894, +0.0367] (78%)  logloss -0.0273 [-0.2228, +0.1684] (64%)  auc +0.2750 [+0.2305, +0.3197] (100%)  ece +0.1016 [-0.0098, +0.1450] (4%)
  gbt       vs climatology brier -0.0660 [-0.1102, -0.0303] (100%)  logloss -0.1747 [-0.2733, -0.0946] (100%)  auc +0.3653 [+0.3277, +0.4021] (100%)  ece +0.0725 [-0.0240, +0.1003] (5%)
  gbt       vs rule        brier -0.0699 [-0.1057, -0.0409] (100%)  logloss -0.1814 [-0.2657, -0.1117] (100%)  auc +0.3134 [+0.2856, +0.3408] (100%)  ece +0.0492 [-0.0384, +0.0751] (12%)
  gbt       vs persistence brier +0.0096 [-0.0242, +0.0374] (29%)  logloss -0.0024 [-0.0853, +0.0683] (54%)  auc +0.0971 [+0.0651, +0.1366] (100%)  ece +0.0397 [-0.0171, +0.0797] (6%)
  gbt       vs gbt_rain    brier -0.1956 [-0.2688, -0.1033] (100%)  logloss -0.7222 [-1.0389, -0.3414] (100%)  auc +0.2646 [+0.1523, +0.3481] (100%)  ece -0.1592 [-0.2224, -0.0896] (100%)
  logistic  vs persistence brier +0.0548 [-0.0138, +0.1207] (6%)  logloss +0.1517 [-0.0530, +0.3609] (7%)  auc +0.0587 [+0.0039, +0.1223] (98%)  ece +0.0921 [+0.0083, +0.1512] (2%)
```

Reliability (n, mean predicted, observed):

```
  logistic: 0.0-0.1: 1283/0.06/0.02 | 0.1-0.2: 1209/0.14/0.09 | 0.2-0.3: 671/0.25/0.15 | 0.3-0.4: 475/0.35/0.23 | 0.4-0.5: 471/0.45/0.30 | 0.5-0.6: 409/0.55/0.33 | 0.6-0.7: 400/0.65/0.35 | 0.7-0.8: 320/0.75/0.42 | 0.8-0.9: 404/0.85/0.48 | 0.9-1.0: 887/0.97/0.74
  gbt: 0.0-0.1: 1668/0.05/0.04 | 0.1-0.2: 1021/0.15/0.11 | 0.2-0.3: 751/0.25/0.15 | 0.3-0.4: 618/0.35/0.19 | 0.4-0.5: 510/0.45/0.18 | 0.5-0.6: 393/0.55/0.27 | 0.6-0.7: 324/0.65/0.40 | 0.7-0.8: 306/0.75/0.58 | 0.8-0.9: 350/0.85/0.79 | 0.9-1.0: 588/0.96/0.95
  persistence: 0.1-0.2: 5456/0.18/0.14 | 0.7-0.8: 1073/0.75/0.91
```

**Reading, 311.** GBT beats climatology and the rain rule clearly (Brier -0.066 [-0.110, -0.030] and -0.070 [-0.106, -0.041]; log-loss and AUC too). **Logistic does not**: its Brier gain over climatology is not distinguishable from zero (interval [-0.094, +0.050]) and its AUC is high only because it ranks well. **A one-feature persistence rule does as well as the GBT on Brier** (0.121 against 0.131; the difference [-0.024, +0.037] includes zero) and is better calibrated; the GBT's AUC is higher (0.865 against 0.768). **Rain alone fails**: the GBT without 311 and DOT features scores a Brier of 0.326, worse than climatology (0.197), with an ECE of 0.257. Most of the skill is "311 reports are already elevated", not rain forecasting. **Calibration does not hold out of time**: the middle bins are overconfident (GBT: predicted 0.45, observed 0.18 in the 0.4 to 0.5 bin) while its top bin is right (0.96 predicted, 0.95 observed); logistic is overconfident almost everywhere. Platt scaling was fitted on 2024, where 37.6% of ticks were positive, against 26.7% in the test years. The ECE is 0.098 for the GBT and 0.150 for logistic, against 0.025 for climatology. On validation, where the calibrators were fitted, the GBT's ECE is 0.018.

**Target traffic: 5,945 ticks, 197 events, 7.7% positive.**

```
model           Brier            95% CI  log-loss            95% CI    AUC          95% CI    ECE          95% CI
climatology    0.0716    [0.049, 0.100]    0.2738    [0.210, 0.353]  0.500  [0.500, 0.500]  0.015  [0.001, 0.043]
rule           0.0713    [0.049, 0.100]    0.2715    [0.208, 0.351]  0.558  [0.514, 0.587]  0.013  [0.001, 0.041]
logistic       0.0562    [0.039, 0.077]    0.2161    [0.154, 0.293]  0.786  [0.681, 0.870]  0.023  [0.010, 0.047]
gbt            0.0600    [0.041, 0.083]    0.2273    [0.162, 0.306]  0.770  [0.674, 0.844]  0.021  [0.008, 0.048]
persistence    0.0714    [0.049, 0.097]    0.2638    [0.196, 0.343]  0.626  [0.543, 0.707]  0.026  [0.010, 0.053]
gbt_rain       0.0742    [0.048, 0.107]    0.3546    [0.241, 0.496]  0.579  [0.458, 0.674]  0.053  [0.029, 0.086]
```

```
  logistic  vs climatology brier -0.0154 [-0.0289, -0.0045] (100%)  logloss -0.0577 [-0.1011, -0.0200] (100%)  auc +0.2860 [+0.1806, +0.3698] (100%)  ece +0.0075 [-0.0304, +0.0393] (32%)
  logistic  vs rule        brier -0.0151 [-0.0284, -0.0042] (100%)  logloss -0.0554 [-0.0984, -0.0178] (100%)  auc +0.2280 [+0.1311, +0.3097] (100%)  ece +0.0099 [-0.0286, +0.0385] (28%)
  gbt       vs climatology brier -0.0116 [-0.0221, -0.0030] (100%)  logloss -0.0465 [-0.0771, -0.0173] (100%)  auc +0.2705 [+0.1741, +0.3441] (100%)  ece +0.0057 [-0.0339, +0.0395] (34%)
  gbt       vs rule        brier -0.0113 [-0.0218, -0.0027] (100%)  logloss -0.0443 [-0.0742, -0.0150] (100%)  auc +0.2126 [+0.1089, +0.3050] (100%)  ece +0.0080 [-0.0310, +0.0390] (30%)
  gbt       vs persistence brier -0.0114 [-0.0170, -0.0065] (100%)  logloss -0.0366 [-0.0525, -0.0220] (100%)  auc +0.1444 [+0.0617, +0.2353] (100%)  ece -0.0046 [-0.0239, +0.0158] (64%)
  gbt       vs gbt_rain    brier -0.0142 [-0.0281, -0.0043] (100%)  logloss -0.1273 [-0.2070, -0.0640] (100%)  auc +0.1911 [+0.0549, +0.3490] (100%)  ece -0.0322 [-0.0474, -0.0117] (100%)
  logistic  vs persistence brier -0.0152 [-0.0233, -0.0085] (100%)  logloss -0.0477 [-0.0706, -0.0249] (100%)  auc +0.1599 [+0.0782, +0.2447] (100%)  ece -0.0027 [-0.0234, +0.0179] (59%)
```

**Reading, traffic.** This is the clearer positive result. Logistic and GBT beat climatology, the rain rule **and the persistence rule** with intervals that exclude zero (logistic against persistence: Brier -0.015 [-0.023, -0.009]; GBT against persistence -0.011 [-0.017, -0.007]), and they stay well calibrated out of time (ECE 0.02). The skill is modest in absolute terms (Brier 0.056 against 0.072, AUC 0.79) and comes from the last hour's slowdown share (largest feature) together with 311 and the clock; the rain-only model has little (AUC 0.58).

**Does the model beat the rule baseline and climatology on test?** Traffic: yes, for both logistic and GBT, on Brier, log-loss and AUC, with calibration intact. 311: the GBT does on Brier, log-loss and AUC, the logistic does only on AUC; neither is better calibrated than the constant models, and neither is significantly better than a one-feature persistence rule on Brier.

## F. Honest limits

- **Independent events:** train 456, validate 102, test 206 (traffic 356, 88, 197); none is thin. Ticks within an event are strongly correlated, which is why every interval resamples whole events.
- **The 3 cascade-tier events** (a scored subset, not a statistic). Ida (1 Sep 2021) and the 2023 flood are in the TRAIN split, so the in-sample scores flatter the model; "held-out" retrains without that event (same hyperparameters, Platt from validation). 14 Jul 2025 is in the test split. Brier / mean predicted probability, for the 311 target (the event's observed share of positive ticks is 95%, 73% and 100%):

```
--- 311: the 3 cascade-tier events (Brier / mean predicted / observed rate / ticks) ---
  Ida 2021-09-01 [2021-09-01T17:35, train, 98 ticks, observed positive 95%] in-sample: climatology 0.479/0.29, rule 0.350/0.40, logistic 0.038/0.91, gbt 0.027/0.91
  Ida 2021-09-01 [2021-09-01T17:35, train, 98 ticks, observed positive 95%] held-out: climatology 0.486/0.29, rule 0.357/0.39, logistic 0.039/0.91, gbt 0.033/0.89
  flood 2023-09-29 [2023-09-28T21:30, train, 217 ticks, observed positive 73%] in-sample: climatology 0.389/0.29, rule 0.302/0.40, logistic 0.173/0.79, gbt 0.076/0.73
  flood 2023-09-29 [2023-09-28T21:30, train, 217 ticks, observed positive 73%] held-out: climatology 0.396/0.29, rule 0.308/0.39, logistic 0.176/0.80, gbt 0.147/0.73
  flood 2025-07-14 [2025-07-14T19:05, test, 36 ticks, observed positive 100%] out-of-sample (test): climatology 0.500/0.29, rule 0.424/0.36, logistic 0.002/0.99, gbt 0.001/0.98
```

For traffic (observed positive 66%, 56%, 33%):

```
--- traffic: the 3 cascade-tier events (Brier / mean predicted / observed rate / ticks) ---
  Ida 2021-09-01 [2021-09-01T17:35, train, 87 ticks, observed positive 66%] in-sample: climatology 0.542/0.09, rule 0.541/0.09, logistic 0.203/0.43, gbt 0.226/0.34
  Ida 2021-09-01 [2021-09-01T17:35, train, 87 ticks, observed positive 66%] held-out: climatology 0.548/0.09, rule 0.547/0.09, logistic 0.203/0.44, gbt 0.331/0.24
  flood 2023-09-29 [2023-09-28T21:30, train, 206 ticks, observed positive 56%] in-sample: climatology 0.467/0.09, rule 0.464/0.10, logistic 0.123/0.44, gbt 0.129/0.37
  flood 2023-09-29 [2023-09-28T21:30, train, 206 ticks, observed positive 56%] held-out: climatology 0.477/0.08, rule 0.475/0.08, logistic 0.176/0.36, gbt 0.173/0.32
  flood 2025-07-14 [2025-07-14T19:05, test, 36 ticks, observed positive 33%] out-of-sample (test): climatology 0.280/0.09, rule 0.278/0.10, logistic 0.294/0.16, gbt 0.306/0.12
```

The 311 model gets these three right (held-out Brier 0.033, 0.147 and 0.001 against climatology 0.49, 0.40 and 0.50): all three are heavy-rain events that are easy to rank. **The traffic models do worse than climatology on 14 Jul 2025** (0.29 to 0.31 against 0.28): the one cascade-tier event in the test split is a case they miss, and one event proves nothing.
- **The 311 label measures reporting, not damage.** The threshold is a dry-day 99th percentile with a median of 6 reports an hour, so almost any real rain event triggers it (29.5% of rain ticks are positive). It is a "reports are far above normal" target, which is also why persistence works so well.
- **Calibration drift is real.** Platt scaling fitted on one year inherits that year's base rate. A deployed probability would need recalibration on a rolling window.
- **DOT is hourly and a registry approximation:** link health uses hourly counts (at least 12 hours with at least 6 readings) as a stand-in for the 144-report rule of Phase 8, and the pool for the traffic threshold reuses the baseline of the tick's day.
- Events are assigned by their first tick; the 2026 311 category rename is handled but 2026 has one fewer power-proxy signal (not used here).
- **No claim about the duty-officer system:** the model is offline and not connected to the engine.

## G. Two identical runs from cache

`nowcast-data.ts` followed by `train.py`, run twice; SHA-256 prefixes of `ticks.csv`, both model files, both fixtures, the training output and `results.json`:

```
run 1: 6bae76a26422 3d17bfe3d77f 2c62af38c1f5 a5e2f5f463b3 8b1cd1dc1315 03b075f26ff0 145d670a4dde
run 2: 6bae76a26422 3d17bfe3d77f 2c62af38c1f5 a5e2f5f463b3 8b1cd1dc1315 03b075f26ff0 145d670a4dde
```

## How to run

```
npm ci && pip install -r scripts/ml/requirements.txt          # Python is for training only
npx tsx scripts/real/fetch9.ts                                # raw data, cached; set SHARD=k SHARDS=8 to run the DOT months in parallel
npx tsx scripts/real/nowcast-data.ts                          # data/ml/ticks.csv and the label summary
python3 scripts/ml/train.py                                   # trains, evaluates, writes ml/models/*.json and the test fixtures
npx vitest run tests/nowcast.test.ts tests/nowcast-data.test.ts
npx tsx scripts/real/diagnose-llr.ts                          # step A
```

Captures: `data/real-eval-p9-data.txt`, `-train.txt`, `-llr.txt`.
