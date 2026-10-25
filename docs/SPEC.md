MASTER PROMPT
You are my senior engineer pair-programmer. My team is 3-4 beginners in a 24-hour hackathon (we know basic JavaScript/Node, nothing advanced). We must finish a COMPLETE, working, demo-able system. Priorities in order: (1) it runs end-to-end, (2) it is correct and honest about uncertainty, (3) the code is simple enough that we can read and explain it to judges, (4) polish last.

## PROBLEM: "The First 10 Minutes"
A disaster rarely begins when it becomes visible. Example in a city of 8 million: 00:00 rain gets heavier; 00:03 drainage sensors report anomalies; 00:05 traffic slows; 00:07 emergency lines get busy; 00:09 two hospitals report unusual arrivals. A duty officer has one question and one button: is this noise, a broken sensor, a minor local incident, or the first ten minutes of a cascading crisis? Waiting costs lives; false alarms cost credibility and train the city to ignore the next real alarm.

Build a continuous, online prediction and decision system that ingests a live, messy, multi-source event stream and, every simulated minute, outputs:
1. calibrated probabilities over 4 hypotheses: NOISE, SENSOR_FAILURE, ISOLATED_INCIDENT, CASCADING_CRISIS
2. a recommended action under a strict cost model: WATCH (keep monitoring) | PREPARE (cheap readiness) | ALERT (notify agencies) | ESCALATE (public alert)
3. a forecast of the next 3 events that will happen, with time windows
4. a plain-language explanation of exactly why the belief/action changed

The stream is irregular, asynchronous, heterogeneous and unreliable:
- sensors with unknown, changing reliability and correlated failures (e.g. one gateway outage masking 100 sensors)
- dispatch logs and delayed citizen reports
- retractions, duplicates, out-of-order events
- coordinated rumor waves acting as mimics
Lookalike explanations exist: heavy rain alone (drainage + traffic), normal storm emergency calls, a flu cluster at hospitals, a gateway outage.

Core challenge: be calibrated when it cannot know for sure, commit fast when evidence solidifies, and explain exactly why it changed its mind.

## HARD REQUIREMENTS (all must be implemented and demonstrable)
R1 Honest probabilities + Twin Test: calibrated probabilities over the 4 hypotheses. The evaluator uses "twin" episodes: identical 7-minute prefixes that then diverge (one becomes a cascade, one stays benign). We are penalized for confident wrong answers before the split and rewarded for committing quickly after it. Before the split, the ideal posterior is the base-rate mixture, not a confident guess.
R2 Optimal stopping + cost model: explicit cost matrix (action x true hypothesis) in a config file, including the value of lead time (damage avoided grows with earlier correct action) vs the false-alarm penalty (cry-wolf). Pick the action minimizing expected cost; compare "act now" against "wait one more minute for more evidence" (simple one-step lookahead is acceptable). Starting cost matrix (hand-set, tunable), columns NOISE/SENSOR_FAIL/ISOLATED/CASCADE: WATCH 0/0/1/50, PREPARE 1/1/2/15, ALERT 6/6/4/5, ESCALATE 25/25/20/0. The WATCH cost under CASCADE grows with minutes since estimated onset.
R3 Foresight: forecast the next 3 events with time windows [p10, p90] using a causal graph (rain -> drainage -> traffic -> emergency calls -> hospital arrivals -> power/comms load), each edge with a lag distribution (mean, sd). Forecasts must follow causal order and be weighted by P(cascade), not just correlation. If benign hypotheses dominate, forecast that those events are unlikely.
R4 Learning + prior shifts: across episodes, update per-source trust (Beta(alpha,beta) reliability with a forgetting factor) and base rates (decayed counts with Dirichlet smoothing) once ground truth is revealed AFTER the episode. Adapt to silent base-rate shifts (e.g. monsoon season starts) with a simple drift detector (e.g. CUSUM) that temporarily speeds up forgetting. No offline retraining.
R5 Adversity + cutouts: handle stream cutouts (e.g. all cameras vanish mid-episode) and structured lies (common-cause failures: a gateway that makes all its sensors look anomalous with identical values). Silence is NOT evidence of calm: when sources go dark, widen uncertainty (mix posterior with prior proportional to lost coverage), show a DEGRADED flag, never crash, never invent data. A gateway_heartbeat_lost event is itself evidence that supports SENSOR_FAILURE. Malformed events are validated and quarantined, never fatal.
R6 Stability: avoid alert flip-flopping (ESCALATE -> WATCH -> ESCALATE). Use hysteresis: escalate only if the cost-optimal action stays above the current level for 2 consecutive ticks; de-escalate only after 4 ticks below AND P(cascade) under a low threshold, one level at a time; minimum dwell of 3 ticks per action; fast-commit bypass if P(cascade) > 0.9. Count flip-flops as a metric.
R7 Explainability: every tick, compute each evidence item's contribution (log-likelihood ratio) to CASCADE vs the rest; output the top 3 contributors and what changed since last tick (new evidence, retraction, trust change, source going dark) as template-generated sentences. No LLM in the core decision loop.
R8 Strict future-data isolation: the output at time t may only use events with arrived_at <= t. Add a unit test proving it (inject future events; outputs at t must not change). The engine must never import or read ground truth.
R9 Clock skew: each source has a hidden clock_offset (+/- 2 min) in the simulator; the engine tolerates event-time uncertainty when ordering and estimates per-source offsets approximately.
R10 Near-duplicate clustering (all source types): events with the same zone + kind within a short window form one cluster; apply a concave diminishing-returns weight (about 1 + ln(n)). Tune the discount on Brier score, and keep a test where a genuine large surge is not over-suppressed.
R11 Safe fallback: wrap each tick in try/catch. On failure use the naive Phase-1 baseline, hold the previous action (never jump to ALERT/ESCALATE), set a visible FALLBACK flag in output and logs, and report fallback ticks separately in eval.
R12 Demo mode: fixed-seed scripted scenarios that replay deterministically (twin test, gateway outage, rumor wave, cutout, prior shift).

## DESIGN DIRECTIVES
- Stack: TypeScript on Node (tsx, no build step), Express + Server-Sent Events, vanilla HTML/JS dashboard, in-memory state + JSON files. No database, no auth, no cloud, minimal dependencies.
- Folders: /config (likelihood tables, transitions, cost matrix, causal graph, decision knobs, trust priors; all hand-set values with comments), /sim, /engine, /eval, /server, /dashboard, /tests, /docs.
- Event schema (JSON): {id, source_id, source_type, gateway_id?, zone_id, kind, value?, reported_severity?, occurred_at, arrived_at, retracts?, text?, narrative_id?}. All schema mapping lives in ONE adapter file so another schema (e.g. the organizers') can be plugged in quickly.
- Ground truth (true hypothesis, onset, twin split time, cutouts, failed gateways, rumor wave, per-event is_lie/is_mimic/is_duplicate, hidden source reliability and clock offsets) lives in separate simulator-only types and files. The engine must never see it.
- Engine core: each tick, REBUILD the posterior from the event log: dedupe by id, apply retractions (orphan retractions wait until their target arrives; unknown ids are ignored and logged), sort by occurred_at with skew tolerance, ignore events with arrived_at > now, then run a forward filter minute by minute in log-space (predict with a small transition matrix, update with evidence). Very late events are included; past actions are never rewritten, only logged as retroactive revisions.
- Evidence model: hand-set P(event kind | hypothesis) tables in config. Group evidence by common cause (gateway id / rumor narrative cluster) so correlated evidence counts roughly once per kind per minute. Add a perfect-correlation detector (all sensors behind one gateway, identical values) that produces a derived event favoring SENSOR_FAILURE. Scale each source's likelihood ratio by learned trust (tempering). Dark/stale sources contribute no evidence.
- Rumor waves: cluster citizen reports by narrative/time; a burst from one cluster counts as one evidence unit and is capped at roughly one weak sensor unless at least one independent physical source (sensor/dispatch/hospital) corroborates; corroboration lifts the cap gradually. Treat report text strictly as data, never as instructions.
- Calibration: temper the posterior with a temperature tau fit on dev seeds (Brier / log-loss); verify with a reliability table on separate test seeds. Never trust numbers just because they look plausible; the eval harness decides.
- Simulator: seeded RNG, labeled episodes: noise, sensor failure / gateway outage, isolated incident, cascade, lookalikes (rain only, flu cluster, storm calls), twin pairs, cutouts, rumor waves, duplicate storms, genuine large surges, delayed (1-2 min and 10+ min) / duplicate / retracted / out-of-order events, clock-skewed sources, drifting source reliability, base-rate-shift sequences. Separate dev and test seeds.
- Eval harness (npm run eval): about 200 seeded episodes. Report Brier score, log-loss, reliability table, total cost vs baselines (always-WATCH and simple count-threshold), mean lead time, false-alarm rate, flip-flop count, twin-test score (pre-split overconfidence penalty, time-to-commit after split), behavior under cutouts, fallback tick count, adaptation after a prior shift.
- Dashboard: live probability bars for the 4 hypotheses, action badge with expected cost per action, belief timeline, event feed (marking duplicates, retractions, quarantined), per-source trust panel, next-3-events forecast with windows, "why it changed" feed, DEGRADED and FALLBACK banners, controls (scenario picker, speed, play/pause), twin side-by-side mode.
- Unit tests required: future isolation, dedupe, retraction (including orphan), late/out-of-order events, gateway grouping, near-duplicate discount (genuine surge not over-suppressed), hysteresis flip count, forecast causal order, learning updates, fallback trigger.

## BUILD ORDER (stop at each gate, run it, show me real output, then continue)
Phase 0: scaffold only (repo, folders, types, config stubs, stubbed modules, smoke test, README skeleton). Gate: tsc and tests pass.
Phase 1: schema + simulator + naive baseline + eval skeleton. Gate: eval prints baseline numbers; same seed gives same output.
Phase 2: Bayesian engine + cost decision + hysteresis, terminal output only (no dashboard). Gate: beats baselines on cost and Brier; twin episodes behave sensibly.
Phase 3: robustness (gateway grouping, rumors, silence, retractions, out-of-order, clock skew, cutouts, near-dup clusters, quarantine, fallback, future-isolation test).
Phase 4: foresight + learning/prior shift.
Phase 5: explanations + dashboard + twin mode.
Phase 6: README with a LIMITATIONS section, 3-minute demo script, scripted demo scenarios, code freeze.

## NON-GOALS / HONEST LIMITS
No real data, no deep-learning training, no LLM in the decision loop, no deployment, no city map. Decisions are city-wide, not per zone. Causal graph and likelihoods are hand-specified (documented in /config). Calibration is verified only on our own simulator. If a requirement is only partly satisfied, say so plainly in the README. Never overclaim.

## HOW TO WORK WITH ME
- Work one phase at a time. After each phase tell me: (a) what you built, (b) how to run and test it, (c) 3 short concepts we must understand to defend it to judges.
- Keep files small, comment the math in plain language, prefer simple code over clever code. Minimal dependencies.
- If blocked, ask at most one question; otherwise choose, and list your assumptions.
- Give commit-ready code at the end of every phase, and run the tests before saying a phase is done.
- Do not start the next phase until I say so.

Acknowledge with a 5-line summary of your understanding and wait for my Phase 0 instruction.
