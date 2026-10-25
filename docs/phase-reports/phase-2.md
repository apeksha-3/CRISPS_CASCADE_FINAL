# Phase 2 report: engine core

Adapter, validate, log, dedupe, retractions, ordering, source status, forward filter, decision with hysteresis, tick runner with fallback, eval integration.
Not in this phase: near-duplicate clustering (step 6), common-cause / gateway grouping (step 7), forecast (step 13), explanations (step 14), learning.

## Gate (real output)

### 1. Type check and tests

```
$ npx tsc --noEmit; echo exit=$?
exit=0
```

```
$ npx vitest run --reporter=verbose
 ✓ tests/baseline.test.ts > count-threshold baseline > only uses events with arrived_at <= t (adding future events changes nothing)
 ✓ tests/baseline.test.ts > count-threshold baseline > counts anomalies in the last 5 minutes only, ignoring heartbeats
 ✓ tests/baseline.test.ts > count-threshold baseline > dedupes by id
 ✓ tests/baseline.test.ts > count-threshold baseline > applies a normal retraction
 ✓ tests/baseline.test.ts > count-threshold baseline > orphan retraction: retraction first, target later => target treated as retracted
 ✓ tests/baseline.test.ts > count-threshold baseline > retraction of an unknown id never affects anything (discarded at episode end)
 ✓ tests/baseline.test.ts > count-threshold baseline > maps counts to actions and returns a 4-way probability vector summing to 1
 ✓ tests/baseline.test.ts > count-threshold baseline > does not crash on malformed (fuzzed) events
 ✓ tests/tick.test.ts > tick runner > runs a whole cascade episode without fallback, and probabilities sum to 1
 ✓ tests/no-truth-import.test.ts > engine isolation > no engine file imports from sim/ or eval/, or the truth types
 ✓ tests/tick.test.ts > tick runner > is deterministic: same episode, same records
 ✓ tests/tick.test.ts > tick runner > falls back to the baseline when the filter throws, never crashing and never raising the action
 ✓ tests/tick.test.ts > tick runner > future isolation (R8): events that arrive later never change the output at t
 ✓ tests/tick.test.ts > tick runner > quarantines malformed (fuzzed) events and counts unparseable ones, without crashing
 ✓ tests/adapter-validate.test.ts > adapter > returns null for input that is not an event
 ✓ tests/adapter-validate.test.ts > adapter > passes our own schema through unchanged
 ✓ tests/adapter-validate.test.ts > adapter > renames fields and coerces types from another schema
 ✓ tests/adapter-validate.test.ts > validator > accepts a normal event
 ✓ tests/adapter-validate.test.ts > validator > quarantines NaN and non-finite numbers
 ✓ tests/adapter-validate.test.ts > validator > quarantines events that arrive in the future (vs the engine clock)
 ✓ tests/adapter-validate.test.ts > validator > quarantines missing required fields
 ✓ tests/adapter-validate.test.ts > validator > quarantines unknown kinds and unknown zones
 ✓ tests/adapter-validate.test.ts > validator > does NOT quarantine clock skew (occurred_at after arrived_at)
 ✓ tests/sim.test.ts > determinism > same type + seed + options gives byte-identical JSON
 ✓ tests/filter.test.ts > forward filter > rain -> drainage -> traffic in one zone raises P(cascade)
 ✓ tests/filter.test.ts > forward filter > gateway_heartbeat_lost pushes toward SENSOR_FAILURE
 ✓ tests/filter.test.ts > forward filter > dark sources nudge toward SENSOR_FAILURE, and lost coverage widens toward the prior
 ✓ tests/filter.test.ts > forward filter > only fresh events are scored, and a withdrawn (retracted) event is subtracted back out
 ✓ tests/filter.test.ts > forward filter > probabilities always sum to 1
 ✓ tests/metrics.test.ts > Brier and log-loss > perfect, uniform and confidently-wrong forecasts
 ✓ tests/metrics.test.ts > Brier and log-loss > Brier by hand: p = (0.6, 0.1, 0.1, 0.2), truth CASCADE
 ✓ tests/metrics.test.ts > cost > uses the matrix, and WATCH under CASCADE grows 5 per minute after onset
 ✓ tests/metrics.test.ts > cost > per-episode cost is normalized by episode length in ticks
 ✓ tests/metrics.test.ts > flip-flops > counts direction reversals only
 ✓ tests/source-status.test.ts > source status > goes live -> stale -> dark with heartbeat gaps (2x and 4x the 300 s interval)
 ✓ tests/source-status.test.ts > source status > a gateway_heartbeat_lost makes every sensor behind it dark immediately
 ✓ tests/decide.test.ts > expected cost > computes sum_H P(H) * cost(action, H) and picks the minimum
 ✓ tests/decide.test.ts > hysteresis > needs 2 consecutive ticks above before going up
 ✓ tests/decide.test.ts > hysteresis > needs 4 consecutive ticks below (and a low P(cascade)) before stepping down ONE level
 ✓ tests/decide.test.ts > hysteresis > an alternating signal produces no flip-flops
 ✓ tests/decide.test.ts > hysteresis > minimum dwell: after a change, stays at least 3 ticks
 ✓ tests/decide.test.ts > hysteresis > fast commit: P(cascade) > 0.9 jumps straight to ESCALATE, ignoring dwell and streaks
 ✓ tests/smoke.test.ts > smoke > cost matrix has all 4 actions x 4 hypotheses
 ✓ tests/smoke.test.ts > smoke > cost matrix matches the spec's starting values
 ✓ tests/smoke.test.ts > smoke > transition rows and base rates sum to 1
 ✓ tests/log.test.ts > event log > refuses events that have not arrived yet
 ✓ tests/log.test.ts > event log > deduplicates by id
 ✓ tests/log.test.ts > event log > getWindow uses arrived_at for the range and sorts by occurred_at
 ✓ tests/log.test.ts > event log > activeEvents excludes retracted events
 ✓ tests/log.test.ts > event log > orphan retraction waits, then applies when its target arrives
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
 Test Files  11 passed (11)
      Tests  61 passed (61)
```

61 tests (29 from Phase 1 + 32 new).

### 2. Eval on the test split, engine policy (with count-threshold alongside)

```
$ npm run eval -- --split test --policy engine

> first-10-minutes@0.0.1 eval
> tsx eval/harness.ts --split test --policy engine

Policy: engine   split: test   episodes: 302   ticks: 13038

  Brier score (mean per episode, 0 best, 2 worst)  0.528
  Log-loss (mean per episode)                      0.990
  Cost per tick (mean of per-episode cost/ticks)   2.85
  Total cost (raw sum over all ticks)              37866
  Mean lead time vs critical time (min)            -6.67   (88/88 cascades reached ALERT+)
  False-alarm rate (benign episodes with ALERT+)   10.1%   (16/158)
  Flip-flops                                       265 total, 0.88 per episode
  Twin: pre-split overconfidence (0 = base rates)  0.048
  Twin: time-to-commit after split (p>=0.6, min)  cascade 9.07 (never: 0), benign 1.30 (never: 0)
  Fallback ticks                                   0

group                        n     truth  Brier LogLoss Cost/tick  ALERT+ Lead(min) Flips
cascade                     40      CASC  0.532   0.972      6.74  100.0%     -7.07     0
cutout:cameras              12 NOISE/CASC/ISO  0.478   0.876      3.58   41.7%     -5.33     9
cutout:gateway               8  ISO/CASC  0.632   1.225      6.38   62.5%     -7.50     6
drifting                     6 NOISE/CASC  0.348   0.658      3.64   50.0%     -7.24     3
duplicate_storm              5       ISO  0.388   0.663      1.48    0.0%         -     8
isolated_incident           40       ISO  0.784   1.166      1.53    0.0%         -    53
lookalike:flu_cluster        9     NOISE  0.155   0.337      0.46   11.1%         -    12
lookalike:gateway_outage     9      SENS  0.760   1.241      0.42    0.0%         -    13
lookalike:rain_only         12     NOISE  0.319   0.560      4.79   75.0%         -    10
lookalike:storm_calls       10     NOISE  0.921   1.364      0.37    0.0%         -    18
noise                       40     NOISE  0.133   0.343      0.47    0.0%         -    44
rumor_wave:pure              3     NOISE  0.632   0.906      0.52    0.0%         -     3
rumor_wave:with_real         3       ISO  0.453   0.742      1.42    0.0%         -     3
sensor_failure:lie          20      SENS  1.658   3.833      2.09   15.0%         -    23
sensor_failure:outage       20      SENS  0.438   0.821      0.43    0.0%         -    25
surge                        5      CASC  0.498   0.896      6.38  100.0%     -5.57     0
twin:benign                 30     NOISE  0.077   0.225      0.86   10.0%         -    33
twin:cascade                30      CASC  0.520   0.941      6.85  100.0%     -6.33     2

ALERT+ = share of episodes where the policy ever reached ALERT or ESCALATE (a false alarm when truth is NOISE/SENS).

Policy comparison, split test
policy            Brier LogLoss Cost/tick FalseAlarm Lead(min) Flips Fallback
always-watch      0.797   1.493     44.86       0.0%         -     0        0
count-threshold   0.724   1.324      7.73      34.8%     -3.88   589        0
engine            0.528   0.990      2.85      10.1%     -6.67   265        0

engine vs count-threshold: Brier -0.195 (engine better), false-alarm rate -24.7 pts (engine better), cost/tick -4.87 (engine better)  -> engine wins 3/3

saved /home/claude/CRISPS/data/eval-results.json
```

count-threshold on the same split, for reference (unchanged from Phase 1 except the twin overconfidence line, see (d)):

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
  Twin: pre-split overconfidence (0 = base rates)  0.033
  Twin: time-to-commit after split (p>=0.6, min)  cascade 10.26 (never: 7), benign 5.27 (never: 0)
  Fallback ticks                                   0
```

### 3. Determinism: two runs, diffed

```
$ npm run eval -- --split test --policy engine > run1.txt; cp data/eval-results.json results1.json
$ npm run eval -- --split test --policy engine > run2.txt; cp data/eval-results.json results2.json
$ diff run1.txt run2.txt && echo "text identical"
text identical
$ cmp results1.json results2.json && echo "json identical"
json identical
```

### 4. Engine vs count-threshold (needs 2 of 3)

| metric (test, 302 episodes) | count-threshold | engine | delta |
|---|---|---|---|
| Brier score | 0.724 | 0.528 | **-0.195** (better) |
| False-alarm rate | 34.8% (55/158) | 10.1% (16/158) | **-24.7 pts** (better) |
| Cost per tick | 7.73 | 2.85 | **-4.87** (better) |
| Mean lead time | -3.88 min | -6.67 min | -2.79 min (**worse**, expected in Phase 2) |

Engine wins 3/3. It is worse on lead time, which the brief allows for this phase.

### 5. Gateway-lie episodes (20)

Group row: count-threshold `sensor_failure:lie  20  SENS  1.268  2.213  4.58  100.0%`; engine `sensor_failure:lie  20  SENS  1.658  3.833  2.09  15.0%`.
So the false-alarm rate goes from 100% (20/20) to **15% (3/20)**. But the engine's Brier on these is *worse* (1.658 against 1.268), because it believes the lie is a stormy NOISE day; see the sanity verdict.

```
$ npx tsx eval/trace.ts --split test --group sensor_failure:lie
policy engine, split test, groups starting with "sensor_failure:lie"
episode                      group                base               truth              max action first ALERT+  ESCALATE ticks  degraded ticks  fallback
test-sensor_failure-5041     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5043     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 14                    23               0  0
test-sensor_failure-5045     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5047     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5049     sensor_failure:lie   -                  SENSOR_FAILURE     ALERT      min 15                     0               0  0
test-sensor_failure-5051     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5053     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5055     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5057     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5059     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5061     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5063     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5065     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 10                    26               0  0
test-sensor_failure-5067     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5069     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5071     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5073     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5075     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5077     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
test-sensor_failure-5079     sensor_failure:lie   -                  SENSOR_FAILURE     PREPARE    -                          0               0  0
```

```
$ npx tsx eval/trace.ts --split test --group sensor_failure:lie --policy count-threshold
policy count-threshold, split test, groups starting with "sensor_failure:lie"
episode                      group                base               truth              max action first ALERT+  ESCALATE ticks  degraded ticks  fallback
test-sensor_failure-5041     sensor_failure:lie   -                  SENSOR_FAILURE     ALERT      min 7                      0               0  0
test-sensor_failure-5043     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 10                    10               0  0
test-sensor_failure-5045     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 6                      9               0  0
test-sensor_failure-5047     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 12                     6               0  0
test-sensor_failure-5049     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 8                     10               0  0
test-sensor_failure-5051     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 9                      9               0  0
test-sensor_failure-5053     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 12                     6               0  0
test-sensor_failure-5055     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 6                      8               0  0
test-sensor_failure-5057     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 5                      7               0  0
test-sensor_failure-5059     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 8                     10               0  0
test-sensor_failure-5061     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 11                     7               0  0
test-sensor_failure-5063     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 7                      9               0  0
test-sensor_failure-5065     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 9                      8               0  0
test-sensor_failure-5067     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 6                      9               0  0
test-sensor_failure-5069     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 13                     7               0  0
test-sensor_failure-5071     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 9                      8               0  0
test-sensor_failure-5073     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 6                      7               0  0
test-sensor_failure-5075     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 13                     5               0  0
test-sensor_failure-5077     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 13                     6               0  0
test-sensor_failure-5079     sensor_failure:lie   -                  SENSOR_FAILURE     ESCALATE   min 10                     6               0  0
```

### 6. Fallback count across the test set

`Fallback ticks 0` in the engine table above (13,038 ticks, 302 episodes). The fallback path itself is exercised by a unit test that injects a filter error (`tests/tick.test.ts`).

### 7. Cutout episodes: no ESCALATE on a non-cascade cutout

Every cutout episode whose underlying situation is noise or an isolated incident (10 of 20) peaks at PREPARE with 0 ESCALATE ticks. The 10 cutouts on top of a real cascade escalate, which is correct.

```
$ npx tsx eval/trace.ts --split test --group cutout
policy engine, split test, groups starting with "cutout"
episode                      group                base               truth              max action first ALERT+  ESCALATE ticks  degraded ticks  fallback
test-cutout-5230             cutout:cameras       noise              NOISE              PREPARE    -                          0               0  0
test-cutout-5231             cutout:cameras       cascade            CASCADING_CRISIS   ESCALATE   min 16                    24               0  0
test-cutout-5232             cutout:cameras       cascade            CASCADING_CRISIS   ESCALATE   min 13                    28               0  0
test-cutout-5233             cutout:gateway       isolated_incident  ISOLATED_INCIDENT  PREPARE    -                          0               0  0
test-cutout-5234             cutout:gateway       cascade            CASCADING_CRISIS   ESCALATE   min 20                     9               0  0
test-cutout-5235             cutout:cameras       noise              NOISE              PREPARE    -                          0               0  0
test-cutout-5236             cutout:cameras       cascade            CASCADING_CRISIS   ESCALATE   min 16                    26               0  0
test-cutout-5237             cutout:cameras       cascade            CASCADING_CRISIS   ESCALATE   min 20                    19               0  0
test-cutout-5238             cutout:gateway       cascade            CASCADING_CRISIS   ESCALATE   min 14                    28               0  0
test-cutout-5239             cutout:gateway       cascade            CASCADING_CRISIS   ESCALATE   min 19                    23               0  0
test-cutout-5240             cutout:cameras       isolated_incident  ISOLATED_INCIDENT  PREPARE    -                          0               0  0
test-cutout-5241             cutout:cameras       isolated_incident  ISOLATED_INCIDENT  PREPARE    -                          0               0  0
test-cutout-5242             cutout:cameras       isolated_incident  ISOLATED_INCIDENT  PREPARE    -                          0               0  0
test-cutout-5243             cutout:gateway       isolated_incident  ISOLATED_INCIDENT  PREPARE    -                          0               0  0
test-cutout-5244             cutout:gateway       cascade            CASCADING_CRISIS   ESCALATE   min 17                    24               0  0
test-cutout-5245             cutout:cameras       isolated_incident  ISOLATED_INCIDENT  PREPARE    -                          0               0  0
test-cutout-5246             cutout:cameras       isolated_incident  ISOLATED_INCIDENT  PREPARE    -                          0               0  0
test-cutout-5247             cutout:cameras       cascade            CASCADING_CRISIS   ESCALATE   min 17                    23               0  0
test-cutout-5248             cutout:gateway       isolated_incident  ISOLATED_INCIDENT  PREPARE    -                          0               0  0
test-cutout-5249             cutout:gateway       cascade            CASCADING_CRISIS   ESCALATE   min 18                    23               0  0
```

`degraded ticks` is 0 everywhere. Coverage never fell below the 0.7 DEGRADED line: the lowest coverage in any test cutout was 0.77 (gateway) and 0.85 (cameras). Widening still happened. A coverage of 0.8 mixes 20% of the base rates into the posterior. The flag just never fired; see (d).

### 8. One cascade, tick by tick

```
$ npx tsx eval/trace.ts --split test --episode test-cascade-5120     (minutes 0-22 shown)
test-cascade-5120  group cascade  truth CASCADING_CRISIS  onset 3.5 min  critical 13.0 min
first stage starts (min): rain_heavy 3.5, drainage_anomaly 6.5, traffic_slowdown 8.6, citizen_report 8.6, emergency_call_spike 10.9, power_comms_load 12.4, hospital_arrivals_unusual 13.0
 min  P(NOISE) P(SENS)  P(ISO)   P(CASC)  action    E[cost]  coverage flags
   0  0.550    0.150    0.200    0.100    (prior: the belief before the first tick)
   1  0.570    0.144    0.193    0.093    WATCH       4.83   1.00    
   2  0.586    0.140    0.187    0.087    PREPARE     2.41   1.00    
   3  0.591    0.139    0.185    0.086    PREPARE     2.39   1.00    
   4  0.600    0.136    0.181    0.083    PREPARE     2.34   1.00    
   5  0.706    0.072    0.184    0.038    PREPARE     1.71   1.00    
   6  0.712    0.072    0.179    0.037    PREPARE     1.70   1.00    
   7  0.722    0.070    0.172    0.036    PREPARE     1.67   1.00    
   8  0.807    0.043    0.105    0.045    PREPARE     1.73   1.00    
   9  0.879    0.020    0.057    0.044    PREPARE     1.68   1.00    
  10  0.905    0.007    0.039    0.049    PREPARE     1.72   1.00    
  11  0.917    0.003    0.018    0.062    PREPARE     1.89   1.00    
  12  0.913    0.002    0.014    0.071    PREPARE     2.01   1.00    
  13  0.890    0.002    0.014    0.094    PREPARE     2.33   1.00    
  14  0.823    0.001    0.017    0.159    PREPARE     3.24   1.00    
  15  0.744    0.000    0.012    0.243    PREPARE     4.41   1.00    
  16  0.652    0.001    0.021    0.327    PREPARE     5.59   1.00    
  17  0.505    0.000    0.042    0.453    PREPARE     7.39   1.00    
  18  0.468    0.001    0.055    0.476    ALERT       5.41   1.00    
  19  0.166    0.000    0.030    0.803    ALERT       5.14   1.00    
  20  0.005    0.000    0.002    0.993    ESCALATE    0.16   1.00    
  21  0.000    0.000    0.000    1.000    ESCALATE    0.01   1.00    
  22  0.001    0.000    0.002    0.997    ESCALATE    0.07   1.00
```

Asked-for minutes: P(cascade) = 0.100 (min 0, the prior), 0.038 (5), 0.049 (10), 0.243 (15), 0.993 (20). It rises over time, but not monotonically. From minute 0 to 10 it drops below the prior, because rain, drainage and traffic alone look like a stormy day (NOISE climbs to 0.91). It turns once emergency calls (10.9), power load (12.4) and hospital arrivals (13.0) start. That is about the true critical time (13.0). ALERT comes at minute 18; fast-commit ESCALATE comes at minute 20.

## Sanity check verdict

**My call: the engine is clearly better than the baseline, but not "amazing", and Phase 3 has plenty to fix. The sim is not too easy overall, and the likelihoods are not overfitted (one hand-set pass on dev, then the test numbers came out the same: dev Brier 0.525 / FA 8.6% / cost 2.78, test 0.528 / 10.1% / 2.85). There is one easy axis in the sim that I want to flag: reported_severity.**

Where it is still fooled or weak, as the brief predicted:
- **Gateway lie: fooled in belief.** It rarely alarms (15% FA, because power alarms with no calls before them point away from cascade), but it believes "stormy NOISE day" at ~0.9 and pushes SENSOR_FAILURE to ~0. Brier on lies is 1.658, worse than count-threshold's 1.268. 100+ identical readings count as 100+ independent pieces of evidence. Step 7 (gateway grouping + perfect-correlation detector) is exactly the fix.
- **Rumor waves inflate the wrong thing.** They push P(ISOLATED), not P(cascade): pure-rumor episodes peak at P(ISO) 0.83 / 0.59 / 0.75 while P(cascade) stays under 0.13. That is because the citizen-report row leans ISOLATED. No false alarm, but Brier 0.632 against plain noise's 0.133. Step 6 (narrative clustering + cap) fixes it.
- **Lead time is worse than the baseline** (-6.67 against -3.88 min). At the first tick after the true critical time, the median P(cascade) over the 88 test cascades is 0.066 (p90 0.12, none above 0.33). This is the risk Phase 1 flagged: critical time (~min 11) comes before cascades and lookalikes separate (~min 12-16). It does affect results. The engine essentially sees the cascade only after damage starts. I did **not** change the simulator.
- **Rain-only lookalike: 75% false alarms** (9/12, against count-threshold's 83%). Without a forecast that says "a cascade would have hospital arrivals by now", nothing counts the missing downstream signals.
- **The posterior jumps** (0.45 to 0.80 to 0.99 in two minutes) once downstream events arrive, because every event counts independently. Twin pre-split overconfidence is 0.048, worse than count-threshold's 0.033.
- Isolated incidents (Brier 0.784) and storm-call days (0.921) are still poorly separated.

Where the win actually comes from: an ablation on the test split (diagnostic only; nothing was tuned on it):

```
full engine                        Brier 0.528  cost 2.85  FA 10.1%  lead -6.67  flips 265  lieFA 15%
no severity gate                   Brier 0.878  cost 8.29  FA 88.0%  lead -3.46  flips 351  lieFA 100%
no causal chaining (all 'alone')   Brier 0.859  cost 39.99  FA 0.0%  lead NaN  flips 316  lieFA 0%
no silence nudge                   Brier 0.580  cost 2.87  FA 10.1%  lead -6.67  flips 268  lieFA 15%
no silence + no widening (all live) Brier 0.578  cost 2.85  FA 10.1%  lead -6.67  flips 272  lieFA 15%
no hysteresis                      Brier 0.528  cost 2.64  FA 10.1%  lead -5.72  flips 260  lieFA 15%
```

Honest reading, which differs from the brief's expectation:
- **Almost all of the win is the likelihood structure.** Two parts carry it:
  - **The severity gate.** An event reported below severity 0.5 counts as an everyday blip. Without the gate, false alarms are 88%.
  - **Causal chaining.** Hospital and power only count as cascade evidence after calls; traffic only after drainage; and so on. Without chaining the engine never alerts at all: cost 40 per tick.
- **Silence handling helps Brier** (0.580 to 0.528), mostly on sensor_failure outages and gateway-outage lookalikes. It does not change actions.
- **Calibration widening barely moves the totals.** Coverage never drops much here (lowest 0.77), so it only shaves confidence during cutouts.
- **Hysteresis does not pay for itself on this test set.** Without it: 260 flips instead of 265, cost 2.64 instead of 2.85, lead 1 minute better. The recursive filter already moves smoothly, so the optimal action rarely flip-flops. Most remaining "flips" are one WATCH to PREPARE to WATCH arc per benign episode: the 10% prior cascade rate makes PREPARE optimal at start, then the belief calms down. Hysteresis is still worth keeping as a guarantee against jumpy inputs (backlog dumps, retractions); the unit tests show it suppressing an alternating signal completely. But I will not claim it improved these numbers.

On "sim too easy": the severity gate is a fairly clean separator in the simulator. Background blips are 0.15-0.55, real events 0.45-0.95, and lies and rumors 0.8-0.95. That makes "is anything real happening at all?" easier than it would be on real feeds, and it explains the low false-alarm rate on plain noise. It does not make the hard questions easy: lie vs cascade, rumor vs incident, rain-only vs cascade, and early warning. Phase 3 has something to improve on all of those. If you want the sim harder on this axis, the knob is the severity ranges in `sim/emit.ts` / `sim/builders.ts`. I would leave it alone for now and note it as a limitation.

## (a) What was built

```
engine/adapter.ts        raw JSON -> Event: field aliases (event_id, sensor_id, type, timestamp, ...) + number coercion; null = unknown schema
engine/validate.ts       Event -> valid | quarantined + reason (missing fields, future arrived_at, NaN, unknown kind, unknown zone). Clock skew passes.
engine/log.ts            EventLog: append-only array + Map index; append -> added|duplicate|future; retract / pending (orphan) retractions;
                         getWindow / activeEvents (arrived_at range, sorted by occurred_at)
engine/order.ts          cleaned window: active events of the last 15 min, occurred_at minus estimated offset, sorted, marked chained / fresh
engine/source-status.ts  SourceTracker: live / stale / dark from 2x / 4x heartbeat interval + gateway_heartbeat_lost; coverage()
engine/filter.ts         forwardFilter: predict (transition matrix) -> add tempered log-likelihoods of fresh events, subtract withdrawn ones,
                         silence nudge -> normalize -> widen by coverage; DEGRADED if coverage < 0.7
engine/decide.ts         expected cost per action, optimal action, hysteresis (2 up / 4 down + P(cascade) thresholds / dwell 3 / fast commit 0.9)
engine/fallback.ts       count-threshold baseline as fallback, action capped at the previous action
engine/tick.ts           Engine class: the per-tick pipeline, try/catch around steps 5-8, TickRecord
config/priors.ts         base rates [0.55, 0.15, 0.20, 0.10]
config/likelihoods.ts    per-kind log-likelihood rows (alone / chained + upstream rule), severity gate, low-severity row
config/transitions.ts    now "stay, or forget 2% toward the base rates" (was a hand-typed matrix that drifted toward CASCADE)
config/knobs.ts          FILTER_KNOBS (window, trust 0.7 citizens, silence nudges, degraded line); hysteresis thresholds per level
eval/baselines.ts        Policy can now be stateful (start(registry) -> step(newEvents, t)); `engine` policy added
eval/run.ts              stateful policies get only the new arrivals each tick
eval/harness.ts/report.ts  3-row policy comparison table + "engine vs count-threshold" delta line whenever the engine runs
eval/trace.ts            tick-by-tick trace of one episode, or one line per episode for a group
tests/                   adapter-validate, log, source-status, filter, decide, tick (fallback, future isolation, fuzz) + helpers;
                         no-truth-import extended (also eval/, also the truth type names, checks the new files are scanned)
```

How the filter avoids double counting: the posterior carries forward as next tick's prior, so each event must be scored exactly once. The window marks events `fresh` (not scored yet) and the filter scores only those. Older window events are still used as causal context: was there drainage before this traffic? The engine remembers what each event added. If that event is retracted later, its contribution is subtracted ("withdrawn"). Orphan retractions work through the log's pending set: the target is never scored. Late events are scored when they arrive.

## (b) How to run

```
npm install
npx tsc --noEmit && npm test
npm run sim -- --build                                   # needed once per fresh checkout (data/ is gitignored)
npm run eval -- --split test --policy engine             # engine table + 3-row comparison + delta line
npm run eval -- --split dev --policy all                 # all three, full tables
npx tsx eval/trace.ts --split test --episode test-cascade-5120     # tick-by-tick belief
npx tsx eval/trace.ts --split test --group cutout                  # one line per episode (any group prefix)
```

## (c) Three concepts

1. **What the forward filter does, intuitively.** It is a running tally of "which story explains what I'm seeing best". Each minute it starts from last minute's belief. It lets a little of that belief fade back toward the base rates, so old impressions can be corrected. Then each new event "votes": for every hypothesis it adds a number saying how typical that event is under that story. A hospital surge after a wave of calls adds a lot to CASCADE. A gateway going silent adds a lot to SENSOR_FAILURE. A low-severity blip nudges NOISE. Adding these numbers is multiplying probabilities (Bayes' rule), done with logs so nothing underflows. At the end we turn the tallies back into 4 probabilities that sum to 1. Causal order matters: the same three events in the wrong order count less toward cascade (unit-tested).
2. **Why hysteresis prevents flip-flop.** The cost-optimal action can bounce when the belief hovers near a boundary, e.g. P(cascade) at 0.32 / 0.35 / 0.31 around the ALERT line. Pressing ALERT, cancelling and pressing again trains agencies to ignore us. Hysteresis is a thermostat with a dead band. It moves up only after 2 ticks in a row agree. It moves down only after 4 ticks agree and P(cascade) is clearly low (under 0.3 to leave ALERT, under 0.15 to leave PREPARE), and only one step at a time. It never changes twice within 3 ticks. The exception is overwhelming evidence (P(cascade) > 0.9), which goes straight to ESCALATE. In the unit test an alternating "ALERT, calm, ALERT, calm" signal never moves the action off WATCH.
3. **What calibration widening does during cutouts.** When sources go dark we have fewer eyes, and silence must not read as calm. So we blend the posterior with the base rates in proportion to what we lost: posterior = coverage x belief + (1 - coverage) x base rates. With 80% of sources live, at most 80% of the confidence survives. The engine cannot lock onto "all quiet, NOISE 0.99" just because the cameras vanished. Below 70% coverage it raises DEGRADED. Separately, every dark source adds a small push toward SENSOR_FAILURE: a silent sensor is weak evidence that sensors are broken, not that the city is fine or on fire.

## (d) Assumptions and changes to locked types

Type changes (engine/types.ts):
- `SourceStatus`: `"ok"` renamed to **`"live"`** (`"live" | "stale" | "dark"`), to match the brief.
- New `ProbabilityVector = Record<Hypothesis, number>` and `ActionLevel = Action` (aliases, the brief's names).
- New `SourceSummary { live, stale, dark, total, coverage }`, `QuarantinedEvent { event, reason }`, `CleanedEvent extends Event { adjusted_occurred_at, chained, fresh }`.
- `TickRecord`: **added** `expected_cost` (cost of the chosen action), `source_summary`, `unparsed` (adapter null count this tick). **Replaced** `quarantined_ids: string[]` with `quarantined: QuarantinedEvent[]` (the event plus why).
- `engine/dedupe.ts` deleted: dedupe and retractions live in `engine/log.ts` now. Stubs for cluster/forecast/explain/learn are untouched.

Config changes:
- `config/priors.ts` (new) holds the base rates `[0.55, 0.15, 0.20, 0.10]`. `BASE_RATES` in transitions.ts now re-exports it (was `[0.6, 0.15, 0.17, 0.08]`). Side effect: **always-WATCH's numbers moved** (Brier 0.826 to 0.797; cost unchanged at 44.86), and so did the twin pre-split overconfidence metric, which measures distance from BASE_RATES (count-threshold 0.022 to 0.033). count-threshold's other numbers are unchanged.
- `config/transitions.ts`: the placeholder matrix sent 1%/tick into CASCADE with no way back, so with no evidence the belief would drift to "cascade". Replaced by stay-or-forget-2%-toward-base-rates.
- `config/likelihoods.ts`: rewritten from the flat placeholder to alone/chained rows with an upstream rule, plus the severity gate.
- `config/knobs.ts`: `stale_after_minutes` / `dark_after_minutes` replaced by `stale_after_intervals: 2` / `dark_after_intervals: 4`. `deescalate_max_p_cascade` became per level. Added `FILTER_KNOBS`.

Assumptions and choices:
- **The playbook PDF was not available to me.** I followed the step list in your message and the spec. The numbering (steps 0-5, 8-12) is taken from your message.
- **"Posterior becomes next tick's prior" vs "accumulate over the window".** Doing both would count every event about 15 times. So: only fresh events are scored, and the window gives causal context. Retracted, already-scored events are subtracted.
- **The raw (pre-widening) posterior is carried forward.** The widened one is reported and used for the decision. Carrying the widened one forward would compound the widening every tick, so evidence would decay geometrically during a cutout.
- **Widening mixes toward the base rates**, not last tick's belief. "Toward uncertainty" means the base rates.
- **The filter includes the predict step** (transition matrix) before the update, as the spec describes.
- **Clock-offset estimate = nominal_latency_s, as you specified.** I think this is physically odd: latency is a delay, not a clock skew, and a neutral first guess would be 0. The effect is small (15-60 s shifts by source type). Phase 4 replaces it with learned per-source offsets.
- **Severity gate.** Events with reported_severity < 0.5 count as everyday blips (a tiny NOISE-leaning row) instead of their kind's row. This is not in your list. It came from looking at dev event rates, and it is the single biggest lever (see the ablation). Flagged in the sanity verdict.
- **"Chained" rules:**
  - drainage after rain (same zone), traffic after drainage (same zone), calls after traffic (same zone), power after calls (same zone);
  - hospital after 2+ calls anywhere in the city, because the nearest hospital may be in another zone;
  - the predecessor must be strong (severity >= 0.5) and earlier by adjusted occurred_at, within the 15-minute window.
- **Likelihood values are hand-set.** I did one adjustment pass on dev: the rain/drainage/traffic cascade tilts went from 0.1-0.15 down to 0.05-0.06 per event, because with the first values rain-only days and gateway lies alarmed on most episodes. I did not look at test results before fixing them.
- **Going up jumps** to the level the optimal action held on both of the last 2 ticks. It is not forced one level at a time. The spec says "de-escalate one level at a time" and only requires 2 ticks to escalate. Going down is one level at a time. ESCALATE to ALERT uses P(cascade) < 0.5, my choice; you gave thresholds only for the two lower steps.
- **The engine starts at WATCH** with the dwell already satisfied, so it can move at minute 2.
- **No one-step lookahead** ("act now vs wait a minute") yet. The engine's expected cost uses the static matrix, without the growing WATCH-under-cascade term, because the engine does not know the onset. Both are left for later.
- **Source status:**
  - "Heard from" = any event from the source, by arrived_at.
  - At engine start, every source counts as heard from at t = 0.
  - Gateways are not in `registry.sources`, so they do not count toward coverage.
  - A gateway_heartbeat_lost makes its sensors dark until each sends something again.
- **The silence nudge** (0.02 per dark source, 0.01 per stale one, capped at 0.3 per tick) goes only to SENSOR_FAILURE.
- **Fallback.** It uses the baseline's probabilities and action, capped at the previous action, per R11. It sets `degraded = true` as well as `fallback = true`. The prior and the scored set are left untouched, so the events of a failed tick are scored on the next good tick.
- **Validator:**
  - zone_id is required for every kind except heartbeat and retraction;
  - a retraction must name a target;
  - an unknown source_id is not quarantined (organizer data may add sources), but it gets no status.
- **"Pure cutout" = a cutout episode whose underlying situation is not a cascade.**
- **DEGRADED never fired on the test set** (lowest coverage 0.77). The threshold is as you specified. In this sim a cutout loses at most about a quarter of the sources.
