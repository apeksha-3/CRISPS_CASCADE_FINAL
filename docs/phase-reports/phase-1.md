# Phase 1 report: simulator, naive baseline, eval skeleton

No engine logic yet (no Bayesian filter, no decide / forecast / learn).

## Gate (real output)

```
$ npx tsc --noEmit; echo exit=$?
exit=0
```

```
$ npx vitest run --reporter=verbose
 ✓ tests/metrics.test.ts > Brier and log-loss > perfect, uniform and confidently-wrong forecasts
 ✓ tests/metrics.test.ts > Brier and log-loss > Brier by hand: p = (0.6, 0.1, 0.1, 0.2), truth CASCADE
 ✓ tests/metrics.test.ts > cost > uses the matrix, and WATCH under CASCADE grows 5 per minute after onset
 ✓ tests/metrics.test.ts > cost > per-episode cost is normalized by episode length in ticks
 ✓ tests/metrics.test.ts > flip-flops > counts direction reversals only
 ✓ tests/baseline.test.ts > count-threshold baseline > only uses events with arrived_at <= t (adding future events changes nothing)
 ✓ tests/baseline.test.ts > count-threshold baseline > counts anomalies in the last 5 minutes only, ignoring heartbeats
 ✓ tests/baseline.test.ts > count-threshold baseline > dedupes by id
 ✓ tests/baseline.test.ts > count-threshold baseline > applies a normal retraction
 ✓ tests/baseline.test.ts > count-threshold baseline > orphan retraction: retraction first, target later => target treated as retracted
 ✓ tests/baseline.test.ts > count-threshold baseline > retraction of an unknown id never affects anything (discarded at episode end)
 ✓ tests/baseline.test.ts > count-threshold baseline > maps counts to actions and returns a 4-way probability vector summing to 1
 ✓ tests/baseline.test.ts > count-threshold baseline > does not crash on malformed (fuzzed) events
 ✓ tests/smoke.test.ts > smoke > cost matrix has all 4 actions x 4 hypotheses
 ✓ tests/smoke.test.ts > smoke > cost matrix matches the spec's starting values
 ✓ tests/smoke.test.ts > smoke > transition rows and base rates sum to 1
 ✓ tests/no-truth-import.test.ts > engine isolation > no engine file imports from sim/
 ✓ tests/sim.test.ts > determinism > same type + seed + options gives byte-identical JSON
 ✓ tests/sim.test.ts > determinism > different seeds give different episodes
 ✓ tests/sim.test.ts > determinism > dev and test seed ranges never overlap
 ✓ tests/sim.test.ts > twin pairs > all events with arrived_at <= split_time are byte-identical
 ✓ tests/sim.test.ts > twin pairs > split is between minute 5 and 9 with at least 40 prefix events, labels differ
 ✓ tests/sim.test.ts > events > contain no hidden fields
 ✓ tests/sim.test.ts > events > occurred_at = true time + source clock offset; arrived_at >= true time
 ✓ tests/sim.test.ts > events > retractions exist, and some arrive before their target (orphans)
 ✓ tests/sim.test.ts > events > fuzz option injects malformed events
 ✓ tests/sim.test.ts > world and sizes > world matches the spec: ~10 zones, 6 gateways, 80-120 sources, big gateway 25+
 ✓ tests/sim.test.ts > world and sizes > non-heartbeat event count is within 100-700 for a sample of seeds
 ✓ tests/sim.test.ts > world and sizes > rain_only shares >= 3 signal kinds with a cascade in the first 8 minutes
 Test Files  5 passed (5)
      Tests  29 passed (29)
```

```
$ npm run sim -- --build
dev: 302 episodes
  cascade                     40 episodes, mean 426 non-heartbeat events
  cutout:cameras              12 episodes, mean 191 non-heartbeat events
  cutout:gateway               8 episodes, mean 308 non-heartbeat events
  drifting                     6 episodes, mean 284 non-heartbeat events
  duplicate_storm              5 episodes, mean 243 non-heartbeat events
  isolated_incident           40 episodes, mean 180 non-heartbeat events
  lookalike:flu_cluster        9 episodes, mean 188 non-heartbeat events
  lookalike:gateway_outage     9 episodes, mean 175 non-heartbeat events
  lookalike:rain_only         12 episodes, mean 253 non-heartbeat events
  lookalike:storm_calls       10 episodes, mean 228 non-heartbeat events
  noise                       40 episodes, mean 158 non-heartbeat events
  rumor_wave:pure              3 episodes, mean 210 non-heartbeat events
  rumor_wave:with_real         3 episodes, mean 207 non-heartbeat events
  sensor_failure:lie          20 episodes, mean 288 non-heartbeat events
  sensor_failure:outage       20 episodes, mean 156 non-heartbeat events
  surge                        5 episodes, mean 468 non-heartbeat events
  twin:benign                 30 episodes, mean 211 non-heartbeat events
  twin:cascade                30 episodes, mean 456 non-heartbeat events
  ALL                        302 episodes, mean 263 non-heartbeat events (1231 incl. heartbeats)
  -> wrote /home/claude/CRISPS/data/episodes/dev

test: 302 episodes
  cascade                     40 episodes, mean 448 non-heartbeat events
  cutout:cameras              12 episodes, mean 251 non-heartbeat events
  cutout:gateway               8 episodes, mean 310 non-heartbeat events
  drifting                     6 episodes, mean 264 non-heartbeat events
  duplicate_storm              5 episodes, mean 235 non-heartbeat events
  isolated_incident           40 episodes, mean 179 non-heartbeat events
  lookalike:flu_cluster        9 episodes, mean 189 non-heartbeat events
  lookalike:gateway_outage     9 episodes, mean 168 non-heartbeat events
  lookalike:rain_only         12 episodes, mean 254 non-heartbeat events
  lookalike:storm_calls       10 episodes, mean 219 non-heartbeat events
  noise                       40 episodes, mean 158 non-heartbeat events
  rumor_wave:pure              3 episodes, mean 206 non-heartbeat events
  rumor_wave:with_real         3 episodes, mean 213 non-heartbeat events
  sensor_failure:lie          20 episodes, mean 291 non-heartbeat events
  sensor_failure:outage       20 episodes, mean 152 non-heartbeat events
  surge                        5 episodes, mean 533 non-heartbeat events
  twin:benign                 30 episodes, mean 221 non-heartbeat events
  twin:cascade                30 episodes, mean 470 non-heartbeat events
  ALL                        302 episodes, mean 270 non-heartbeat events (1237 incl. heartbeats)
  -> wrote /home/claude/CRISPS/data/episodes/test

prior-shift: 100 episodes
  cascade                     20 episodes, mean 440 non-heartbeat events
  isolated_incident           17 episodes, mean 192 non-heartbeat events
  lookalike:flu_cluster        1 episodes, mean 223 non-heartbeat events
  lookalike:rain_only          3 episodes, mean 278 non-heartbeat events
  lookalike:storm_calls        9 episodes, mean 246 non-heartbeat events
  noise                       42 episodes, mean 166 non-heartbeat events
  sensor_failure:lie           3 episodes, mean 326 non-heartbeat events
  sensor_failure:outage        5 episodes, mean 154 non-heartbeat events
  ALL                        100 episodes, mean 240 non-heartbeat events (1194 incl. heartbeats)
  -> wrote /home/claude/CRISPS/data/episodes/prior-shift
```

Building twice gives byte-identical files (sha256 over every episode JSON, in file order):
```
$ (cd data/episodes && find . -name '*.json' | sort | xargs cat | sha256sum)   # build 1
4b0b84b5e4e5b74f8ab613b0098c69fd663809f1692cbd5f10ea2da8186f4704  -
$ npm run sim -- --build; (same command)                                         # build 2
4b0b84b5e4e5b74f8ab613b0098c69fd663809f1692cbd5f10ea2da8186f4704  -
```

```
$ npm run sim -- --stats
== dev: 302 episodes ==
group                         n   mean   min   max   w/ hb  dur(min)  outside
cascade                      40    426   278   551    1441      45.0        0
cutout:cameras               12    191   121   383    1077      42.5        0
cutout:gateway                8    308   153   417    1193      41.5        0
drifting                      6    284   137   511    1232      42.0        0
duplicate_storm               5    243   222   263    1223      42.8        0
isolated_incident            40    180   147   217    1139      42.4        0
lookalike:flu_cluster         9    188   138   212    1129      42.3        0
lookalike:gateway_outage      9    175   144   200    1094      42.9        0
lookalike:rain_only          12    253   208   298    1236      43.1        0
lookalike:storm_calls        10    228   194   278    1192      43.0        0
noise                        40    158   127   204    1107      42.0        0
rumor_wave:pure               3    210   203   217    1200      43.7        0
rumor_wave:with_real          3    207   195   214    1170      43.3        0
sensor_failure:lie           20    288   189   375    1250      42.8        0
sensor_failure:outage        20    156   121   192    1048      42.0        0
surge                         5    468   352   675    1478      45.0        0
twin:benign                  30    211   187   241    1229      45.0        0
twin:cascade                 30    456   318   629    1474      45.0        0
ALL                         302    263   121   675

== test: 302 episodes ==
group                         n   mean   min   max   w/ hb  dur(min)  outside
cascade                      40    448   268   609    1463      45.0        0
cutout:cameras               12    251   154   453    1118      41.7        0
cutout:gateway                8    310   151   523    1176      41.0        0
drifting                      6    264   148   429    1194      41.7        0
duplicate_storm               5    235   213   258    1208      43.0        0
isolated_incident            40    179   144   220    1142      42.4        0
lookalike:flu_cluster         9    189   161   213    1152      42.9        0
lookalike:gateway_outage      9    168   145   183    1105      43.1        0
lookalike:rain_only          12    254   204   308    1216      42.4        0
lookalike:storm_calls        10    219   160   247    1205      43.2        0
noise                        40    158   113   188    1085      41.1        0
rumor_wave:pure               3    206   200   215    1151      41.7        0
rumor_wave:with_real          3    213   198   222    1168      42.3        0
sensor_failure:lie           20    291   221   371    1245      42.5        0
sensor_failure:outage        20    152   120   195    1058      43.0        0
surge                         5    533   375   649    1567      45.0        0
twin:benign                  30    221   184   270    1244      45.0        0
twin:cascade                 30    470   288   600    1493      45.0        0
ALL                         302    270   113   649

== prior-shift: 100 episodes ==
group                         n   mean   min   max   w/ hb  dur(min)  outside
cascade                      20    440   304   579    1446      45.0        0
isolated_incident            17    192   149   218    1155      42.9        0
lookalike:flu_cluster         1    223   223   223    1205      43.0        0
lookalike:rain_only           3    278   275   280    1238      43.3        0
lookalike:storm_calls         9    246   213   277    1189      41.9        0
noise                        42    166   126   215    1099      41.2        0
sensor_failure:lie            3    326   299   378    1294      42.3        0
sensor_failure:outage         5    154   135   180    1051      42.8        0
ALL                         100    240   126   579

Event counts are non-heartbeat events (healthy range 100-700). "w/ hb" includes heartbeats.
Episodes outside 100-700: 0
```

### Eval, test split, both policies

```
$ npm run eval -- --split test --policy always-watch
Policy: always-watch   split: test   episodes: 302   ticks: 13038

  Brier score (mean per episode, 0 best, 2 worst)  0.826
  Log-loss (mean per episode)                      1.557
  Cost per tick (mean of per-episode cost/ticks)   44.86
  Total cost (raw sum over all ticks)              603180
  Mean lead time vs critical time (min)            -   (0/88 cascades reached ALERT+)
  False-alarm rate (benign episodes with ALERT+)   0.0%   (0/158)
  Flip-flops                                       0 total, 0.00 per episode
  Twin: pre-split overconfidence (0 = base rates)  0.000
  Twin: time-to-commit after split (p>=0.6, min)  cascade - (never: 30), benign 1.00 (never: 0)
  Fallback ticks                                   0

group                        n     truth  Brier LogLoss Cost/tick  ALERT+ Lead(min) Flips
cascade                     40      CASC  1.258   2.526    152.74    0.0%         -     0
cutout:cameras              12 NOISE/CASC/ISO  1.009   1.876     60.21    0.0%         -     0
cutout:gateway               8  ISO/CASC  1.190   2.243     89.63    0.0%         -     0
drifting                     6 NOISE/CASC  0.738   1.518     72.68    0.0%         -     0
duplicate_storm              5       ISO  1.078   1.772      1.00    0.0%         -     0
isolated_incident           40       ISO  1.078   1.772      1.00    0.0%         -     0
lookalike:flu_cluster        9     NOISE  0.218   0.511      0.00    0.0%         -     0
lookalike:gateway_outage     9      SENS  1.118   1.897      0.00    0.0%         -     0
lookalike:rain_only         12     NOISE  0.218   0.511      0.00    0.0%         -     0
lookalike:storm_calls       10     NOISE  0.218   0.511      0.00    0.0%         -     0
noise                       40     NOISE  0.218   0.511      0.00    0.0%         -     0
rumor_wave:pure              3     NOISE  0.218   0.511      0.00    0.0%         -     0
rumor_wave:with_real         3       ISO  1.078   1.772      1.00    0.0%         -     0
sensor_failure:lie          20      SENS  1.118   1.897      0.00    0.0%         -     0
sensor_failure:outage       20      SENS  1.118   1.897      0.00    0.0%         -     0
surge                        5      CASC  1.258   2.526    153.01    0.0%         -     0
twin:benign                 30     NOISE  0.218   0.511      0.00    0.0%         -     0
twin:cascade                30      CASC  1.258   2.526    158.28    0.0%         -     0

ALERT+ = share of episodes where the policy ever reached ALERT or ESCALATE (a false alarm when truth is NOISE/SENS).

saved /home/claude/CRISPS/data/eval-results.json
```

```
$ npm run eval -- --split test --policy count-threshold
Policy: count-threshold   split: test   episodes: 302   ticks: 13038

  Brier score (mean per episode, 0 best, 2 worst)  0.724
  Log-loss (mean per episode)                      1.324
  Cost per tick (mean of per-episode cost/ticks)   7.73
  Total cost (raw sum over all ticks)              103097
  Mean lead time vs critical time (min)            -3.88   (85/88 cascades reached ALERT+)
  False-alarm rate (benign episodes with ALERT+)   34.8%   (55/158)
  Flip-flops                                       589 total, 1.95 per episode
  Twin: pre-split overconfidence (0 = base rates)  0.022
  Twin: time-to-commit after split (p>=0.6, min)  cascade 10.26 (never: 7), benign 5.27 (never: 0)
  Fallback ticks                                   0

group                        n     truth  Brier LogLoss Cost/tick  ALERT+ Lead(min) Flips
cascade                     40      CASC  0.756   1.474     24.33   95.0%     -4.03   173
cutout:cameras              12 NOISE/CASC/ISO  0.903   1.625     15.26   41.7%     -4.59    34
cutout:gateway               8  ISO/CASC  0.983   1.776     17.00   75.0%     -4.50    17
drifting                     6 NOISE/CASC  0.519   1.071     18.41   50.0%     -8.24     7
duplicate_storm              5       ISO  1.177   1.942      2.60  100.0%         -     7
isolated_incident           40       ISO  1.258   2.082      1.04    0.0%         -    35
lookalike:flu_cluster        9     NOISE  0.132   0.371      0.03    0.0%         -     6
lookalike:gateway_outage     9      SENS  1.275   2.114      0.03    0.0%         -     3
lookalike:rain_only         12     NOISE  0.357   0.735      1.81   83.3%         -    34
lookalike:storm_calls       10     NOISE  0.242   0.541      0.55   60.0%         -    26
noise                       40     NOISE  0.125   0.361      0.01    0.0%         -     5
rumor_wave:pure              3     NOISE  0.212   0.506      0.95  100.0%         -     3
rumor_wave:with_real         3       ISO  1.191   1.973      1.77  100.0%         -     3
sensor_failure:lie          20      SENS  1.268   2.213      4.58  100.0%         -    26
sensor_failure:outage       20      SENS  1.280   2.118      0.01    0.0%         -     5
surge                        5      CASC  0.636   1.273     20.19  100.0%     -2.97     9
twin:benign                 30     NOISE  0.208   0.490      0.45   53.3%         -    58
twin:cascade                30      CASC  0.710   1.385     21.14  100.0%     -3.20   138

ALERT+ = share of episodes where the policy ever reached ALERT or ESCALATE (a false alarm when truth is NOISE/SENS).

saved /home/claude/CRISPS/data/eval-results.json
```

Run twice, compared:
```
$ npm run eval -- --split test --policy always-watch    > run1.txt   (and again > run2.txt)
$ diff run1.txt run2.txt && echo identical
always-watch: identical
$ (same for count-threshold)
count-threshold: identical
$ cmp eval-results.json(run 1) data/eval-results.json(run 2) && echo json identical
json identical
```

### Timelines (seed 7)

Rows are arrival minutes: row m = events with arrived_at in ((m-1)*60, m*60], i.e. what the tick at minute m sees for the first time. The last column shows where each true stage starts (ground truth, never shown to the engine). Seed 7 uses the same world and background for every type, so differences between timelines are the scenario itself.

```
$ npm run sim -- --type noise --seed 7 --print
Episode noise-7  type=noise
  truth=NOISE  duration=45 min  events=1138 total, 157 non-heartbeat  sources=109  build_attempt=0

 min |  rain drain traff calls  hosp power citiz gwlost  retr    hb | total(no hb) | true stage starts
   1 |     0     0     1     0     0     0     0     0     0    16 |     1    (1) | 
   2 |     0     2     2     0     0     0     0     0     0    23 |     4    (5) | 
   3 |     2     1     2     0     0     0     1     0     0    23 |     6   (11) | 
   4 |     1     0     0     0     0     0     1     0     0    16 |     2   (13) | 
   5 |     1     2     0     0     1     0     1     0     0    21 |     5   (18) | 
   6 |     1     2     1     0     0     1     0     0     0    24 |     5   (23) | 
   7 |     0     0     1     0     0     0     0     0     0    21 |     1   (24) | 
   8 |     0     1     1     0     0     0     0     0     0    26 |     2   (26) | 
   9 |     1     2     1     0     1     0     0     0     0    15 |     5   (31) | 
  10 |     0     0     0     0     1     2     0     0     0    23 |     3   (34) | 
  11 |     0     1     1     1     0     0     0     0     0    23 |     3   (37) | 
  12 |     0     2     1     0     0     0     0     0     0    25 |     3   (40) | 
  13 |     0     1     5     0     0     0     2     0     0    21 |     8   (48) | 
  14 |     0     2     4     0     0     0     1     0     0    19 |     7   (55) | 
  15 |     0     0     1     1     0     0     1     0     2    19 |     5   (60) | 
  16 |     0     1     0     0     0     0     0     0     0    23 |     1   (61) | 
  17 |     0     1     1     0     0     0     0     0     0    24 |     2   (63) | 
  18 |     0     1     0     0     0     1     0     0     0    25 |     2   (65) | 
  19 |     0     2     1     0     0     0     0     0     0    13 |     3   (68) | 
  20 |     2     1     1     0     0     0     1     0     0    22 |     5   (73) | 
  21 |     1     3     1     0     0     0     0     0     0    27 |     5   (78) | 
  22 |     0     1     1     0     0     0     0     0     0    26 |     2   (80) | 
  23 |     0     0     2     1     0     0     0     0     0    22 |     3   (83) | 
  24 |     0     2     1     1     0     0     0     0     0    12 |     4   (87) | 
  25 |     0     1     1     2     0     0     0     0     0    26 |     4   (91) | 
  26 |     0     0     1     0     0     1     0     0     0    25 |     2   (93) | 
  27 |     0     0     0     1     0     0     0     0     0    20 |     1   (94) | 
  28 |     0     0     2     0     0     0     0     0     1    24 |     3   (97) | 
  29 |     1     2     4     0     0     1     0     0     0    21 |     8  (105) | 
  30 |     0     0     0     0     0     0     0     0     0    19 |     0  (105) | 
  31 |     1     0     0     0     0     0     0     0     0    23 |     1  (106) | 
  32 |     0     1     2     0     0     0     0     0     0    21 |     3  (109) | 
  33 |     0     1     0     3     0     0     2     0     0    22 |     6  (115) | 
  34 |     0     0     2     1     0     1     1     0     0    21 |     5  (120) | 
  35 |     0     0     1     0     0     0     2     0     0    18 |     3  (123) | 
  36 |     0     2     0     0     0     0     1     0     0    27 |     3  (126) | 
  37 |     0     1     0     1     0     0     0     0     0    23 |     2  (128) | 
  38 |     0     2     2     0     0     0     0     0     0    17 |     4  (132) | 
  39 |     0     1     0     0     0     1     0     0     0    24 |     2  (134) | 
  40 |     0     1     0     0     0     0     0     0     0    22 |     1  (135) | 
  41 |     0     0     1     0     0     0     1     0     0    20 |     2  (137) | 
  42 |     0     1     1     0     0     0     0     0     0    26 |     2  (139) | 
  43 |     0     2     2     1     0     0     1     0     0    21 |     6  (145) | 
  44 |     1     2     0     0     0     0     0     0     0    20 |     3  (148) | 
  45 |     0     0     1     0     0     1     1     0     0    21 |     3  (151) | 
```

```
$ npm run sim -- --type sensor_failure --variant lie --seed 7 --print
Episode sensor_failure-7  type=sensor_failure variant=lie
  truth=SENSOR_FAILURE  duration=45 min  events=1210 total, 229 non-heartbeat  sources=109  build_attempt=0
  onset 4:31
  gateway gw3 lie 4:31-12:31

 min |  rain drain traff calls  hosp power citiz gwlost  retr    hb | total(no hb) | true stage starts
   1 |     0     0     1     0     0     0     0     0     0    16 |     1    (1) | 
   2 |     0     2     2     0     0     0     0     0     0    23 |     4    (5) | 
   3 |     2     1     2     0     0     0     1     0     0    23 |     6   (11) | 
   4 |     1     0     0     0     0     0     1     0     0    16 |     2   (13) | 
   5 |     1     3     1     0     1     1     1     0     0    21 |     8   (21) | 
   6 |     3     5     5     0     0     3     0     0     0    24 |    16   (37) | 
   7 |     1     1     6     0     0     3     0     0     0    21 |    11   (48) | 
   8 |     1     4     6     0     0     1     0     0     0    26 |    12   (60) | 
   9 |     1     4     5     0     1     2     0     0     0    15 |    13   (73) | 
  10 |     1     2     5     0     1     4     0     0     0    23 |    13   (86) | 
  11 |     2     2     3     1     0     2     0     0     0    23 |    10   (96) | 
  12 |     1     3     6     0     0     3     0     0     0    25 |    13  (109) | 
  13 |     0     3     5     0     0     0     2     0     0    21 |    10  (119) | 
  14 |     0     2     5     0     0     0     1     0     0    19 |     8  (127) | 
  15 |     0     0     1     1     0     0     1     0     2    19 |     5  (132) | 
  16 |     0     1     0     0     0     0     0     0     0    23 |     1  (133) | 
  17 |     0     1     1     0     0     0     0     0     0    24 |     2  (135) | 
  18 |     0     1     0     0     0     1     0     0     0    25 |     2  (137) | 
  19 |     0     2     1     0     0     0     0     0     0    13 |     3  (140) | 
  20 |     2     1     1     0     0     0     1     0     0    22 |     5  (145) | 
  21 |     1     3     1     0     0     0     0     0     0    27 |     5  (150) | 
  22 |     0     1     1     0     0     0     0     0     0    26 |     2  (152) | 
  23 |     0     0     2     1     0     0     0     0     0    22 |     3  (155) | 
  24 |     0     2     1     1     0     0     0     0     0    12 |     4  (159) | 
  25 |     0     1     1     2     0     0     0     0     0    26 |     4  (163) | 
  26 |     0     0     1     0     0     1     0     0     0    25 |     2  (165) | 
  27 |     0     0     0     1     0     0     0     0     0    20 |     1  (166) | 
  28 |     0     0     2     0     0     0     0     0     1    24 |     3  (169) | 
  29 |     1     2     4     0     0     1     0     0     0    21 |     8  (177) | 
  30 |     0     0     0     0     0     0     0     0     0    19 |     0  (177) | 
  31 |     1     0     0     0     0     0     0     0     0    23 |     1  (178) | 
  32 |     0     1     2     0     0     0     0     0     0    21 |     3  (181) | 
  33 |     0     1     0     3     0     0     2     0     0    22 |     6  (187) | 
  34 |     0     0     2     1     0     1     1     0     0    21 |     5  (192) | 
  35 |     0     0     1     0     0     0     2     0     0    18 |     3  (195) | 
  36 |     0     2     0     0     0     0     1     0     0    27 |     3  (198) | 
  37 |     0     1     0     1     0     0     0     0     0    23 |     2  (200) | 
  38 |     0     2     2     0     0     0     0     0     0    17 |     4  (204) | 
  39 |     0     1     0     0     0     1     0     0     0    24 |     2  (206) | 
  40 |     0     1     0     0     0     0     0     0     0    22 |     1  (207) | 
  41 |     0     0     1     0     0     0     1     0     0    20 |     2  (209) | 
  42 |     0     1     1     0     0     0     0     0     0    26 |     2  (211) | 
  43 |     0     2     2     1     0     0     1     0     0    21 |     6  (217) | 
  44 |     1     2     0     0     0     0     0     0     0    20 |     3  (220) | 
  45 |     0     0     1     0     0     1     1     0     0    21 |     3  (223) | 
```

```
$ npm run sim -- --type isolated --seed 7 --print
Episode isolated_incident-7  type=isolated_incident variant=accident
  truth=ISOLATED_INCIDENT  duration=45 min  events=1154 total, 173 non-heartbeat  sources=109  build_attempt=0
  onset 10:14
  stage first starts: traffic_slowdown 10:14, citizen_report 11:14, emergency_call_spike 11:54, hospital_arrivals_unusual 16:32

 min |  rain drain traff calls  hosp power citiz gwlost  retr    hb | total(no hb) | true stage starts
   1 |     0     0     1     0     0     0     0     0     0    16 |     1    (1) | 
   2 |     0     2     2     0     0     0     0     0     0    23 |     4    (5) | 
   3 |     2     1     2     0     0     0     1     0     0    23 |     6   (11) | 
   4 |     1     0     0     0     0     0     1     0     0    16 |     2   (13) | 
   5 |     1     2     0     0     1     0     1     0     0    21 |     5   (18) | 
   6 |     1     2     1     0     0     1     0     0     0    24 |     5   (23) | 
   7 |     0     0     1     0     0     0     0     0     0    21 |     1   (24) | 
   8 |     0     1     1     0     0     0     0     0     0    26 |     2   (26) | 
   9 |     1     2     1     0     1     0     0     0     0    15 |     5   (31) | 
  10 |     0     0     0     0     1     2     0     0     0    23 |     3   (34) | 
  11 |     0     1     1     1     0     0     0     0     0    23 |     3   (37) | traffic@z07
  12 |     0     2     1     0     0     0     0     0     0    25 |     3   (40) | emergency@z07 citizen@z07
  13 |     0     1     5     0     0     0     2     0     0    21 |     8   (48) | 
  14 |     0     2     4     1     0     0     2     0     0    19 |     9   (57) | 
  15 |     0     0     1     5     0     0     1     0     2    19 |     9   (66) | 
  16 |     0     1     0     0     0     0     1     0     0    23 |     2   (68) | 
  17 |     0     1     2     0     0     0     0     0     0    24 |     3   (71) | hospital@z07
  18 |     0     1     2     1     0     1     0     0     0    25 |     5   (76) | 
  19 |     0     2     1     0     0     0     0     0     0    13 |     3   (79) | 
  20 |     2     1     1     0     0     0     1     0     0    22 |     5   (84) | 
  21 |     1     3     1     1     0     0     0     0     0    27 |     6   (90) | 
  22 |     0     1     2     0     0     0     0     0     0    26 |     3   (93) | 
  23 |     0     0     4     1     0     0     0     0     0    22 |     5   (98) | 
  24 |     0     2     1     2     0     0     0     0     0    12 |     5  (103) | 
  25 |     0     1     1     2     0     0     0     0     0    26 |     4  (107) | 
  26 |     0     0     1     0     0     1     0     0     0    25 |     2  (109) | 
  27 |     0     0     0     1     0     0     0     0     0    20 |     1  (110) | 
  28 |     0     0     2     0     0     0     0     0     1    24 |     3  (113) | 
  29 |     1     2     4     0     0     1     0     0     0    21 |     8  (121) | 
  30 |     0     0     0     0     0     0     0     0     0    19 |     0  (121) | 
  31 |     1     0     0     0     0     0     0     0     0    23 |     1  (122) | 
  32 |     0     1     2     0     0     0     0     0     0    21 |     3  (125) | 
  33 |     0     1     0     3     0     0     2     0     0    22 |     6  (131) | 
  34 |     0     0     2     1     0     1     1     0     0    21 |     5  (136) | 
  35 |     0     0     1     0     0     0     2     0     0    18 |     3  (139) | 
  36 |     0     2     0     0     0     0     1     0     0    27 |     3  (142) | 
  37 |     0     1     0     1     0     0     0     0     0    23 |     2  (144) | 
  38 |     0     2     2     0     0     0     0     0     0    17 |     4  (148) | 
  39 |     0     1     0     0     0     1     0     0     0    24 |     2  (150) | 
  40 |     0     1     0     0     0     0     0     0     0    22 |     1  (151) | 
  41 |     0     0     1     0     0     0     1     0     0    20 |     2  (153) | 
  42 |     0     1     1     0     0     0     0     0     0    26 |     2  (155) | 
  43 |     0     2     2     1     0     0     1     0     0    21 |     6  (161) | 
  44 |     1     2     0     0     0     0     0     0     0    20 |     3  (164) | 
  45 |     0     0     1     0     0     1     1     0     0    21 |     3  (167) | 
```

```
$ npm run sim -- --type cascade --seed 7 --print
Episode cascade-7  type=cascade
  truth=CASCADING_CRISIS  duration=45 min  events=1387 total, 406 non-heartbeat  sources=109  build_attempt=0
  onset 3:56
  stage first starts: rain_heavy 3:56, drainage_anomaly 6:37, traffic_slowdown 8:33, citizen_report 8:33, emergency_call_spike 10:58, hospital_arrivals_unusual 13:14, power_comms_load 15:13
  critical time 13:14

 min |  rain drain traff calls  hosp power citiz gwlost  retr    hb | total(no hb) | true stage starts
   1 |     0     0     1     0     0     0     0     0     0    16 |     1    (1) | 
   2 |     0     2     2     0     0     0     0     0     0    23 |     4    (5) | 
   3 |     2     1     2     0     0     0     1     0     0    23 |     6   (11) | 
   4 |     1     0     0     0     0     0     1     0     0    16 |     2   (13) | rain@z07
   5 |     1     2     0     0     1     0     1     0     0    21 |     5   (18) | rain@z06 rain@z08
   6 |     1     2     1     0     0     1     0     0     0    24 |     5   (23) | 
   7 |     0     0     1     0     0     0     0     0     0    21 |     1   (24) | drainage@z06
   8 |     0     1     1     0     0     0     0     0     0    26 |     2   (26) | 
   9 |     1     2     1     0     1     0     0     0     0    15 |     5   (31) | drainage@z07 traffic@z06 citizen@z06 drainage@z08
  10 |     0     0     0     0     1     2     0     0     0    23 |     3   (34) | traffic@z07 citizen@z07
  11 |     0     2     1     1     0     0     0     0     0    23 |     4   (38) | emergency@z06
  12 |     2     7     2     0     0     0     0     0     0    25 |    11   (49) | traffic@z08 citizen@z08
  13 |     0     1     5     0     0     0     5     0     0    21 |    11   (60) | emergency@z07
  14 |     1     4     6     0     0     0     1     0     0    19 |    12   (72) | hospital@z07 CRITICAL
  15 |     1     1     2     2     0     0     3     0     2    19 |    11   (83) | emergency@z08
  16 |     0     3     0     0     0     0     2     0     0    23 |     5   (88) | power@z06
  17 |     2     2     1     1     1     1     0     0     1    24 |     9   (97) | power@z07
  18 |     3     3     2     2     0     1     1     0     0    25 |    12  (109) | 
  19 |     2     4     2     3     2     2     2     0     0    13 |    17  (126) | 
  20 |     5     4     3     5     0     1     2     0     0    22 |    20  (146) | 
  21 |     2     3     1     2     0     2     2     0     0    27 |    12  (158) | power@z08
  22 |     2     3     2     1     1     1     2     0     1    26 |    13  (171) | 
  23 |     2     1     3     4     0     1     0     0     0    22 |    11  (182) | 
  24 |     0     2     1     5     0     0     0     0     2    12 |    10  (192) | 
  25 |     1     1     2     3     1     0     2     0     0    26 |    10  (202) | 
  26 |     1     0     1     1     0     1     0     0     0    25 |     4  (206) | 
  27 |     0     2     1     2     0     3     0     0     0    20 |     8  (214) | 
  28 |     0     0     3     2     0     2     2     0     1    24 |    10  (224) | 
  29 |     1     3     5     1     1     1     0     0     0    21 |    12  (236) | 
  30 |     0     6     0     4     0     1     0     0     0    19 |    11  (247) | 
  31 |     3     1     2     0     0     1     0     0     0    23 |     7  (254) | 
  32 |     0     1     4     1     0     0     1     0     0    21 |     7  (261) | 
  33 |     2     2     0     4     1     0     2     0     0    22 |    11  (272) | 
  34 |     0     1     2     2     0     2     3     0     0    21 |    10  (282) | 
  35 |     1     2     2     0     0     2     4     0     0    18 |    11  (293) | 
  36 |     1     5     0     3     0     0     4     0     0    27 |    13  (306) | 
  37 |     0     1     0     7     0     0     0     0     0    23 |     8  (314) | 
  38 |     1     4     5     2     0     1     0     0     0    17 |    13  (327) | 
  39 |     3     3     0     3     1     1     0     0     0    24 |    11  (338) | 
  40 |     1     5     0     0     0     2     0     0     0    22 |     8  (346) | 
  41 |     0     1     1     2     0     0     2     0     1    20 |     7  (353) | 
  42 |     1     2     2     4     0     0     1     0     0    26 |    10  (363) | 
  43 |     1     2     3     3     1     2     1     0     0    21 |    13  (376) | 
  44 |     2     3     1     1     0     0     1     0     1    20 |     9  (385) | 
  45 |     0     2     3     1     1     1     1     0     2    21 |    11  (396) | 
```

```
$ npm run sim -- --type rain_only --seed 7 --print
Episode rain_only-7  type=lookalike lookalike=rain_only
  truth=NOISE  duration=45 min  events=1325 total, 297 non-heartbeat  sources=114  build_attempt=7
  onset 2:01
  stage first starts: rain_heavy 2:01, drainage_anomaly 3:55, traffic_slowdown 5:06, citizen_report 5:06, emergency_call_spike 6:55

 min |  rain drain traff calls  hosp power citiz gwlost  retr    hb | total(no hb) | true stage starts
   1 |     1     0     2     0     0     1     0     0     0    12 |     4    (4) | 
   2 |     2     0     0     0     0     1     1     0     0    18 |     4    (8) | 
   3 |     0     0     0     0     0     0     0     0     0    17 |     0    (8) | rain@z07 rain@z02 rain@z06
   4 |     1     1     2     2     0     0     0     0     0    27 |     6   (14) | drainage@z07
   5 |     1     2     0     0     1     2     0     0     0    23 |     6   (20) | drainage@z06
   6 |     1     3     2     2     0     0     0     0     0    30 |     8   (28) | traffic@z07 citizen@z07 drainage@z02 traffic@z06 citizen@z06
   7 |     1     2     3     1     0     1     0     0     0    17 |     8   (36) | emergency@z06
   8 |     0     2     1     0     0     0     0     0     0    19 |     3   (39) | emergency@z07 traffic@z02 citizen@z02
   9 |     0     3     0     2     0     0     3     0     1    24 |     9   (48) | 
  10 |     1     2     2     1     0     0     3     0     0    27 |     9   (57) | 
  11 |     1     0     5     0     0     0     3     0     1    29 |    10   (67) | emergency@z02
  12 |     0     2     1     0     0     0     0     0     0    17 |     3   (70) | 
  13 |     3     1     3     1     0     0     2     0     0    17 |    10   (80) | 
  14 |     0     5     3     2     0     0     2     0     2    26 |    14   (94) | 
  15 |     0     3     2     3     1     0     0     0     0    27 |     9  (103) | 
  16 |     1     4     3     3     0     0     0     0     0    25 |    11  (114) | 
  17 |     1     3     3     2     0     0     2     0     2    23 |    13  (127) | 
  18 |     2     3     0     0     0     0     0     0     1    18 |     6  (133) | 
  19 |     0     1     0     1     0     0     2     0     0    26 |     4  (137) | 
  20 |     3     1     1     1     0     0     2     0     0    21 |     8  (145) | 
  21 |     2     6     4     1     0     0     2     0     0    27 |    15  (160) | 
  22 |     1     4     1     1     0     0     0     0     0    20 |     7  (167) | 
  23 |     1     2     3     3     0     0     4     0     0    18 |    13  (180) | 
  24 |     1     2     0     2     0     0     0     0     2    27 |     7  (187) | 
  25 |     0     3     3     2     0     1     3     0     1    20 |    13  (200) | 
  26 |     0     1     1     1     0     1     2     0     1    28 |     7  (207) | 
  27 |     1     1     5     2     0     1     1     0     0    18 |    11  (218) | 
  28 |     0     1     0     1     0     2     3     0     0    21 |     7  (225) | 
  29 |     1     2     0     0     0     0     0     0     1    22 |     4  (229) | 
  30 |     1     0     2     1     0     0     1     0     0    26 |     5  (234) | 
  31 |     1     1     3     0     0     1     0     0     0    26 |     6  (240) | 
  32 |     0     0     2     0     2     1     0     0     0    21 |     5  (245) | 
  33 |     1     3     1     1     0     0     2     0     0    20 |     8  (253) | 
  34 |     0     0     1     0     1     0     0     0     1    20 |     3  (256) | 
  35 |     0     2     0     0     0     0     1     0     0    30 |     3  (259) | 
  36 |     0     2     2     1     0     1     0     0     0    28 |     6  (265) | 
  37 |     0     0     2     0     0     0     1     0     0    17 |     3  (268) | 
  38 |     0     2     0     1     0     1     1     0     0    16 |     5  (273) | 
  39 |     0     1     5     0     0     0     1     0     0    26 |     7  (280) | 
  40 |     0     3     1     0     0     0     1     0     0    24 |     5  (285) | 
  41 |     0     0     0     0     0     0     0     0     0    25 |     0  (285) | 
  42 |     0     1     0     0     0     2     0     0     0    19 |     3  (288) | 
  43 |     0     2     1     1     0     1     1     0     0    21 |     6  (294) | 
  44 |     0     0     1     0     0     0     0     0     0    23 |     1  (295) | 
  45 |     0     1     0     1     0     0     0     0     0    28 |     2  (297) | 
```

```
$ npm run sim -- --type twin --seed 7 --print
Episode twin-7-A  type=twin
  truth=CASCADING_CRISIS  duration=45 min  events=1523 total, 552 non-heartbeat  sources=108  build_attempt=14
  onset 1:34
  stage first starts: rain_heavy 1:34, drainage_anomaly 3:40, traffic_slowdown 5:08, citizen_report 5:08, emergency_call_spike 7:09, power_comms_load 9:31, hospital_arrivals_unusual 12:07
  critical time 12:07
  twin twin-7 role=cascade split 9:00

 min |  rain drain traff calls  hosp power citiz gwlost  retr    hb | total(no hb) | true stage starts
   1 |     0     2     1     0     0     0     0     0     0     7 |     3    (3) | 
   2 |     0     1     2     0     0     1     0     0     0    26 |     4    (7) | rain@z04
   3 |     1     0     1     0     0     0     0     0     0    18 |     2    (9) | rain@z03 rain@z05
   4 |     1     0     0     0     0     0     0     0     0    22 |     1   (10) | drainage@z04
   5 |     0     1     2     1     0     1     2     0     0    25 |     7   (17) | 
   6 |     2     0     1     1     0     0     0     0     0    16 |     4   (21) | traffic@z04 citizen@z04 drainage@z03
   7 |     4     2     1     0     0     0     0     0     0    23 |     7   (28) | 
   8 |     1     1     2     1     0     0     2     0     0    20 |     7   (35) | emergency@z04
   9 |     1     3     3     1     0     0     0     0     0    22 |     8   (43) | traffic@z03 citizen@z03 drainage@z05
 ---- twin split at 9:00: prefix ends here (43 non-heartbeat events arrived so far) ----
  10 |     0     1     1     2     0     0     0     0     0    29 |     4   (47) | power@z04 emergency@z03
  11 |     3     1     2     0     0     0     0     0     0    16 |     6   (53) | 
  12 |     2     5     4     0     0     1     0     0     0    23 |    12   (65) | traffic@z05 citizen@z05
  13 |     2     2     0     0     0     0     1     0     0    21 |     5   (70) | power@z03 emergency@z02 traffic@z02 hospital@z00 hospital@z04 CRITICAL
  14 |     0     3     2     2     0     0     1     0     1    22 |     9   (79) | 
  15 |     0     1     1     1     0     2     1     0     0    27 |     6   (85) | emergency@z05 hospital@z05
  16 |     1     3     4     3     1     1     2     0     0    14 |    15  (100) | emergency@z06 traffic@z06
  17 |     2     1     1     2     1     0     0     0     0    18 |     7  (107) | 
  18 |     2     0     4     5     1     1     3     0     0    25 |    16  (123) | 
  19 |     1     2     9     8     1     1     1     0     0    22 |    23  (146) | 
  20 |     1     3     5     1     0     0     1     0     1    26 |    12  (158) | power@z02 power@z06
  21 |     0     3     5     5     2     0     3     0     0    13 |    18  (176) | 
  22 |     3     2     5     3     0     1     3     0     0    24 |    17  (193) | power@z05
  23 |     0     2     1     3     0     1     2     0     1    24 |    10  (203) | 
  24 |     2     1     6     5     0     1     0     0     1    21 |    16  (219) | 
  25 |     1     2     5     3     1     1     0     0     1    24 |    14  (233) | 
  26 |     1     3     2     4     0     1     2     0     1    18 |    14  (247) | 
  27 |     2     3     2     7     2     1     0     0     0    20 |    17  (264) | 
  28 |     3     4     2    10     0     1     2     0     0    25 |    22  (286) | 
  29 |     0     0     2     5     0     4     0     0     0    21 |    11  (297) | 
  30 |     0     3     4     4     0     2     2     0     0    25 |    15  (312) | 
  31 |     1     0     5     4     1     0     0     0     0    18 |    11  (323) | 
  32 |     4     6     2     8     0     1     0     0     0    20 |    21  (344) | 
  33 |     1     2     1     4     4     1     0     0     0    23 |    13  (357) | 
  34 |     1     1     0     2     1     0     0     0     0    24 |     5  (362) | 
  35 |     1     1     5     1     0     2     0     0     2    22 |    12  (374) | 
  36 |     2     3     2     7     1     1     0     0     0    12 |    16  (390) | 
  37 |     1     4     1     6     1     2     1     0     0    30 |    16  (406) | 
  38 |     4     2     4     5     2     2     1     0     0    22 |    20  (426) | 
  39 |     4     3     4     3     1     1     1     0     0    19 |    17  (443) | 
  40 |     0     0     4     4     0     2     2     0     1    25 |    13  (456) | 
  41 |     0     3     4     6     0     1     1     0     0    14 |    15  (471) | 
  42 |     0     0     3     8     1     2     4     0     0    29 |    18  (489) | 
  43 |     1     4     7     3     0     5     3     0     0    17 |    23  (512) | 
  44 |     4     2     5     3     2     1     1     0     0    31 |    18  (530) | 
  45 |     1     3     3     1     1     2     0     0     0    14 |    11  (541) | 


Episode twin-7-B  type=twin lookalike=rain_only
  truth=NOISE  duration=45 min  events=1164 total, 193 non-heartbeat  sources=108  build_attempt=14
  onset 1:34
  stage first starts: rain_heavy 1:34, drainage_anomaly 3:40, traffic_slowdown 5:08, citizen_report 5:08, emergency_call_spike 7:09
  twin twin-7 role=benign split 9:00

 min |  rain drain traff calls  hosp power citiz gwlost  retr    hb | total(no hb) | true stage starts
   1 |     0     2     1     0     0     0     0     0     0     7 |     3    (3) | 
   2 |     0     1     2     0     0     1     0     0     0    26 |     4    (7) | rain@z04
   3 |     1     0     1     0     0     0     0     0     0    18 |     2    (9) | rain@z03 rain@z05
   4 |     1     0     0     0     0     0     0     0     0    22 |     1   (10) | drainage@z04
   5 |     0     1     2     1     0     1     2     0     0    25 |     7   (17) | 
   6 |     2     0     1     1     0     0     0     0     0    16 |     4   (21) | traffic@z04 citizen@z04 drainage@z03
   7 |     4     2     1     0     0     0     0     0     0    23 |     7   (28) | 
   8 |     1     1     2     1     0     0     2     0     0    20 |     7   (35) | emergency@z04
   9 |     1     3     3     1     0     0     0     0     0    22 |     8   (43) | traffic@z03 citizen@z03 drainage@z05
 ---- twin split at 9:00: prefix ends here (43 non-heartbeat events arrived so far) ----
  10 |     0     1     1     2     0     0     0     0     0    29 |     4   (47) | 
  11 |     3     1     2     0     0     0     0     0     0    16 |     6   (53) | 
  12 |     2     5     4     0     0     1     0     0     0    23 |    12   (65) | 
  13 |     2     2     0     0     0     0     1     0     0    21 |     5   (70) | 
  14 |     0     3     2     0     0     0     1     0     1    22 |     7   (77) | 
  15 |     0     1     1     0     0     0     1     0     0    27 |     3   (80) | 
  16 |     0     2     2     2     0     0     0     0     0    14 |     6   (86) | 
  17 |     0     1     0     0     0     0     0     0     0    18 |     1   (87) | 
  18 |     1     0     2     0     0     0     2     0     0    25 |     5   (92) | 
  19 |     0     1     1     2     0     0     0     0     0    22 |     4   (96) | 
  20 |     0     1     1     1     0     0     0     0     1    26 |     4  (100) | 
  21 |     0     2     3     1     0     0     1     0     0    13 |     7  (107) | 
  22 |     0     0     1     0     0     0     1     0     0    24 |     2  (109) | 
  23 |     0     1     0     0     0     0     1     0     1    24 |     3  (112) | 
  24 |     1     1     3     0     0     0     0     0     0    21 |     5  (117) | 
  25 |     0     1     0     0     0     0     0     0     1    24 |     2  (119) | 
  26 |     0     2     1     0     0     0     1     0     1    18 |     5  (124) | 
  27 |     1     2     0     0     0     1     0     0     0    20 |     4  (128) | 
  28 |     1     0     2     0     0     0     0     0     0    25 |     3  (131) | 
  29 |     0     0     0     0     0     1     0     0     0    21 |     1  (132) | 
  30 |     0     1     1     1     0     1     1     0     0    25 |     5  (137) | 
  31 |     1     0     1     2     0     0     0     0     0    18 |     4  (141) | 
  32 |     1     4     1     1     0     0     0     0     0    20 |     7  (148) | 
  33 |     0     1     0     0     0     1     0     0     0    23 |     2  (150) | 
  34 |     0     0     0     0     0     0     0     0     0    24 |     0  (150) | 
  35 |     1     1     1     0     0     0     0     0     0    22 |     3  (153) | 
  36 |     0     2     1     0     0     0     0     0     0    12 |     3  (156) | 
  37 |     0     1     0     0     0     1     1     0     0    30 |     3  (159) | 
  38 |     1     1     1     0     0     0     0     0     0    22 |     3  (162) | 
  39 |     0     0     2     2     0     0     1     0     0    19 |     5  (167) | 
  40 |     0     0     1     1     0     0     0     0     0    25 |     2  (169) | 
  41 |     0     0     1     2     0     0     0     0     0    14 |     3  (172) | 
  42 |     0     0     2     1     0     1     1     0     0    29 |     5  (177) | 
  43 |     0     1     1     0     0     1     3     0     0    17 |     6  (183) | 
  44 |     1     1     1     1     0     0     0     0     0    31 |     4  (187) | 
  45 |     1     3     0     0     0     0     0     0     0    14 |     4  (191) | 

Prefix check (arrived_at <= 540 s): A has 222 events (43 non-heartbeat), B has 222 (43 non-heartbeat). Byte-identical: YES
```

### Separability diagnostic (dev split, not part of the gate)

```
$ npx tsx eval/separability.ts --split dev
split dev: 70 cascades vs 61 NOISE lookalikes (lookalike:rain_only, lookalike:storm_calls, lookalike:flu_cluster, twin:benign)
 min | AUC total 5-min count | AUC hospital+power 5-min count
   2 |                 0.534 |                          0.524
   4 |                 0.497 |                          0.504
   6 |                 0.479 |                          0.513
   8 |                 0.437 |                          0.462
  10 |                 0.454 |                          0.471
  12 |                 0.515 |                          0.527
  14 |                 0.660 |                          0.599
  16 |                 0.830 |                          0.694
  18 |                 0.910 |                          0.826
  20 |                 0.937 |                          0.876
  25 |                 0.976 |                          0.917
  30 |                 0.998 |                          0.913
```

Mean true critical time (first hospital stage) on test cascades: minute 11.2 (p10 9.3, p90 12.9). Mean onset: minute 2.1.

## Sanity check verdict

**My call: the difficulty is about right, slightly on the hard side in minutes 0-12. It is not too easy, and not too hard.**

What the test-split table says:

- **always-WATCH is terrible on cascades.** 152.7 cost per tick on plain cascades (158.3 on twin cascades) against 44.86 overall. It never alerts (0/88). Its Brier is 0.826 overall and 1.258 on every cascade.
- **count-threshold beats it on cost by about 5.8x**: 7.73 against 44.86 per tick (raw total 103,097 against 603,180). On cascades it drops to 24.3 per tick.
- **But it raises many false alarms**: 34.8% of benign episodes (55/158) reach ALERT or higher. By group: rain_only 83.3%, storm_calls 60.0%, twin benign 53.3%. Plain noise, gateway outage and flu cluster are 0%.
- **The gateway lie fools it: 100% (20/20).** Its 4.58 cost per tick is the worst of any benign group. **The pure rumor wave fools it too: 100% (3/3).** Correlated sensors and a burst of citizen reports just look like more anomalies.
- **It is late.** Mean lead time is -3.88 min, so its first ALERT comes about 4 minutes after the true critical time. 3/88 cascades never reach ALERT. On twins it commits about 10.3 min after the split, and 7/30 cascade twins never commit.
- **Its probabilities are barely better than base rates.** Brier is 0.724 against 0.826. It never recognizes an isolated incident: Brier 1.258 on isolated episodes, worse than always-WATCH's 1.078. It flip-flops 1.95 times per episode.

Why the simulator is not too easy: the baseline is nowhere near perfect. A policy that knew the truth would pay about 0.19 per tick: ESCALATE on cascades costs 0 and WATCH on benign episodes costs 0, so all that is left is the 1-per-tick WATCH cost on the 56 isolated-incident episodes. The baseline pays 7.73. The early minutes are genuinely confusable. In the separability diagnostic, the raw 5-minute count gives AUC 0.44-0.53 between cascades and their NOISE lookalikes from minute 2 to 12, which is a coin flip. Rain-only and storm-call days are even slightly busier than cascades in minutes 6-10.

Why it is not too hard: the separation appears and becomes strong. AUC is 0.66 at minute 14, 0.83 at minute 16, 0.94 at minute 20 and 0.998 at minute 30, even with a crude count. On twins, the post-split continuations differ in kind: hospital and power events appear only in the cascade twin.

Room for the Bayesian engine (Phase 2), with specific targets:
1. Use event kinds and causal order, not raw counts. Hospital plus power after drainage and traffic is the cascade signature; flu clusters have hospital without upstream signals.
2. Group by gateway. That alone would remove the 100% false-alarm rate on the 20 gateway-lie episodes.
3. Cap rumor clusters by narrative_id.
4. Use calibrated probabilities. Brier 0.724 leaves a lot of room, isolated incidents are never identified, and pre-split twins should sit at the base rates (baseline 0.022 overconfidence) and then commit quickly.
5. Use cheap PREPARE early. The engine cannot reliably ALERT before the critical time against lookalikes. The cost matrix rewards PREPARE under uncertainty: 15 under CASCADE against WATCH's 50+.

Risk I see: the critical time (~minute 11) comes before count-level separation (~minute 14-16). Even a good engine may show lead times near zero against lookalikes, and will get positive lead mainly where the episode is clearly not noise. If Phase 2 finds that too harsh, the knobs are `STAGE_RATE_PER_MIN.hospital_arrivals_unusual` and `CASCADE_LAGS.hospital` in `sim/params.ts`. I would rather not tune them now, because tuning the sim to suit the engine is a trap.

## (a) What was built

```
sim/rng.ts       mulberry32 PRNG + rngFor(seed, label) independent sub-streams + stableId
sim/params.ts    every simulator knob, commented (rates, lags, delays, mixes, seed ranges)
sim/truth.ts     GroundTruth / Episode / SimWorld types, lookalike->label mapping, publicRegistry()
sim/world.ts     10 zones (ring + shortcuts), 6 gateways (gw0 has 25+ sensors), ~110 sources
sim/emit.ts      plan -> drafts: stage activations (Poisson thinning), background blips,
                 heartbeats (~5 min), gateway lies (identical values), gateway monitor
sim/noise.ts     drafts -> events: skewed occurred_at, delays 5-90 s (+1-2 min late), retransmissions,
                 retractions (25% orphans), outages (lost or 10+ min backlog dump), fuzz
sim/builders.ts  one small planner per situation (cascade chain, rain-only, storm calls, flu,
                 gateway outage/lie, isolated, rumor wave, duplicate storm)
sim/episode.ts   generateEpisode(type, seed, opts), generateTwinPair(seed), builder validations
sim/dataset.ts   dev/test sets (302 each), 100-episode prior-shift sequence, save/load
sim/print.ts     timeline and stats tables;   sim/cli.ts  the npm run sim CLI
engine/baseline.ts   count-threshold baseline (pure; dedupe, orphan retractions, 4-way probabilities)
eval/baselines.ts    Policy interface, always-watch, count-threshold
eval/metrics.ts      Brier, log-loss, tick cost, flip-flops
eval/run.ts          runs a policy tick by tick (only arrived_at <= t), builds TickRecords, scores one episode
eval/report.ts       aggregation + table;  eval/harness.ts  the npm run eval CLI (+ data/eval-results.json)
eval/separability.ts diagnostic AUC per minute
tests/               sim.test.ts, baseline.test.ts, metrics.test.ts, no-truth-import.test.ts (+ smoke)
```

How twins share a prefix: every emitter (each source's background, each source in each stage, each event's delivery noise) has its own named random stream. Twin B is built from twin A's plan. It only drops stages that start after the split, plus all hospital and power stages, and adds fades that begin after the split. Nothing before the split changes, so every event with arrived_at <= split comes out byte-identical. The builder asserts this, and so does a test.

## (b) How to run

```
npm install
npx tsc --noEmit && npm test
npm run sim -- --build                 # data/episodes/{dev,test,prior-shift}/*.json (gitignored)
npm run sim -- --stats
npm run sim -- --type cascade --seed 7 --print      # also: twin, noise, sensor_failure --variant lie, isolated, rain_only, ...
npm run eval -- --split test --policy always-watch
npm run eval -- --split test --policy count-threshold     # or --policy all; --split dev
npx tsx eval/separability.ts --split dev
```

## (c) Three concepts

1. **Why seeded determinism matters.** Every random number comes from our own generator started from a seed. The same seed gives the same episode, byte for byte. So a bug seen once can be replayed exactly, two versions of the engine are scored on exactly the same episodes, and an eval number means something: if it moves, the code changed, not the dice. It also lets us keep tuning seeds (dev, 1000+) and judging seeds (test, 5000+) apart. If we tuned on the test episodes, our score would be flattering and dishonest. Twins depend on it too. Separate random streams per source and per event are what make two episodes identical up to minute 5-9 and different afterwards.
2. **What the Brier score and calibration mean.** Each minute we give 4 probabilities. Brier = the sum of (probability - outcome)^2, where outcome is 1 for the true hypothesis and 0 for the others. 0 is perfect, 2 is "100% sure and wrong", and always saying the base rates scores 0.83 here. **Calibration** means that when we say 70%, it happens about 70% of the time. Brier rewards honesty: you cannot game it by always sounding confident, because confident misses are punished quadratically, and log-loss punishes them even harder. That is the twin test's point. Before the split the honest answer is "base rates"; the baseline's confident buckets cost it there.
3. **Why we compare against baselines.** A number like "cost 4.2" means nothing alone. Baselines give the floor. always-WATCH is the "do nothing" floor (44.9 per tick, never alerts). count-threshold is the "obvious first idea" (7.7 per tick, but 35% false alarms, fooled by every gateway lie and rumor). The Bayesian engine is only worth its complexity if it clearly beats both on cost and Brier, especially on the lookalike, lie and rumor rows. The baseline is also the R11 fallback, so we know exactly how the system behaves when the main engine fails.

## (d) Assumptions and changes to locked types

Type changes (engine/types.ts):
- **Time unit: minutes -> seconds.** `Minutes` is replaced by `Seconds` (whole seconds). `Event.occurred_at`, `Event.arrived_at`, `TickRecord.tick_time` and `ForecastItem.window_p10/p90` are now seconds. Added `TICK_SECONDS = 60`. The stub signatures in engine/forecast, fallback, log and filter were updated to match.
- `SourceRegistryEntry` gained `heartbeat_interval_s` and `nominal_latency_s` (the public registry fields you listed).
- `Zone` gained `neighbours: string[]`.
- New `Gateway { gateway_id, zone_ids }` and `PublicRegistry { zones, gateways, sources }`. This is everything the engine may see about the world.

Truth types (sim/truth.ts, rewritten):
- `GroundTruth` now holds `episode_type`, `lookalike`, `variant`, `base_type`, `onset`, `stage_times`, `stages`, `critical_time`, `twin_pair_id`, `twin_role`, `split_time`, `build_attempt`, `cutouts`, `failed_gateways` (with mode and backlog), `rumor`, `duplicate_storm`, `surge`, `drifting_sources`, `weather`, `sources` (hidden reliability and offsets), and `event_truths` (now a side map keyed by event id).
- `EventTruth` gained `true_occurred_at`, `is_background`, `retransmissions` and `retracted`.
- `Episode` gained `type` and `registry` and lost `zones` and `scenario`.
- New `SimWorld`, `EpisodeType`, `LookalikeType`, `LOOKALIKE_LABEL`, and `publicRegistry()`.

Other choices:
- **Heartbeats are excluded from the 100-700 health range.** About 110 sources x 9 heartbeats is about 1,000 heartbeats per episode, more than 700 on its own. The 40-event twin prefix minimum also counts non-heartbeat events only, which is stricter. Stats show both numbers.
- **The dataset is ~300 episodes, not ~200.** The buckets you listed (4 x 40 + 40 lookalikes + 30 twin pairs = 60 episodes + 20 cutouts + specials) add up to 302 per split. I kept the buckets.
- **Labels for specials:**
  - Cutout and drifting keep the label of the episode underneath (noise, isolated or cascade). A gateway cutout is only put on isolated or cascade episodes, so it is not confused with sensor_failure.
  - Pure rumor = NOISE. Rumor with a real incident = ISOLATED_INCIDENT.
  - Duplicate storm = ISOLATED_INCIDENT. Surge = CASCADE.
  - The gateway_outage lookalike is an outage plus mild rain, labeled SENSOR_FAILURE.
- **Critical time** = the first hospital stage start. **Onset** = the first rain (cascade) or the incident start.
- **Cost:**
  - WATCH under CASCADE = 50 + 5 x max(0, minutes since true onset).
  - The headline "cost per tick" is the mean over episodes of (episode cost / episode ticks). The raw total is printed too.
- **Definitions:**
  - Benign (for false alarms) = NOISE or SENSOR_FAILURE truth.
  - Lead time = critical time - first tick at ALERT or above.
  - Twin overconfidence = mean squared distance from BASE_RATES over pre-split ticks.
  - Twin commit = first post-split tick where the top hypothesis is the truth with p >= 0.6.
  - always-WATCH outputs BASE_RATES. NOISE = 0.6, so it "commits" to benign twins at once. That is a quirk of the definition, noted here.
- **Baseline:**
  - The window uses arrived_at, not occurred_at, which is skewed.
  - It counts all 7 anomaly kinds including citizen reports. It does not count heartbeats, retractions or gateway_heartbeat_lost.
  - Thresholds are 30 / 40 / 55 per 5 minutes (config/knobs.ts BASELINE_KNOBS), set by eyeballing dev only.
  - Probability buckets: WATCH (.70 .12 .12 .06), PREPARE (.40 .15 .30 .15), ALERT (.20 .10 .35 .35), ESCALATE (.08 .07 .25 .60).
- **Simulator details:**
  - Episode lengths: noise 38-45 min, other types 40-45, cascade, surge and twins 45.
  - Sensors behind gateways: rain, drainage, traffic, camera and utility (power/comms). Dispatch, hospitals and citizens connect directly.
  - Cameras emit traffic_slowdown. Power and comms nodes share source_type `utility`.
  - The lie variant picks the big gateway half the time.
  - Every citizen report carries a narrative_id. Rumor reports share one, and real reports get per-incident ids. That way the mere presence of narrative_id does not give a rumor away.
  - Gateway monitor events come from the gateway id itself, with source_type `gateway`. Gateways are listed in `registry.gateways`, not in `registry.sources`.
  - Event ids are 12-hex hashes, so they leak nothing (no type or twin side in the id).
  - Builder reseeding (rain-only shared-kinds check, twin prefix check) changes an internal stream tag, not the seed, so seed ranges never overlap. `truth.build_attempt` records how many tries were needed.
- `sim/scenarios.ts` was replaced by `sim/cli.ts` plus builders, and `npm run sim` now points at sim/cli.ts. `engine/adapter.ts` stays a stub because the simulator emits our schema directly.
- Ticks are not saved to disk; only per-episode results and summaries go to data/eval-results.json, keyed by split/policy. TickRecords are built in memory.
