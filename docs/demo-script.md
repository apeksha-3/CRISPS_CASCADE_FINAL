# Demo script (3 minutes)

Rehearse with a stopwatch. Speed is **4x** throughout (one simulated minute = 250 ms, so a 45-minute episode plays in about 11 s).
Before going on stage: `npm run demo-check` (all 6 must PASS), then `npm run dev` and open http://localhost:3000.
Every figure below is what the dashboard actually shows for these test-split episodes (checked by `npm run demo-check` and the Phase 6 report).
If the laptop dies, play `docs/demo-recording.mp4` (see [demo-backup.md](demo-backup.md)) and speak over it.

Tip: pausing (Space) is allowed anywhere. Each episode is short at 4x, so pause on the moment you are pointing at, then resume.

---

## 0:00 - 0:30 · Problem + Twin Test setup

*Dashboard on screen, Single mode, Real Cascade loaded (the landing page).*

> "A city of 80 lakh people. Every minute, the system gets rain gauges, drainage sensors, traffic cameras, emergency calls, hospital feeds — all noisy, some lying, some late. It has to decide: is this just noise, a sensor failure, a local incident, or a cascading crisis? And it has to decide in 10 minutes, before damage spreads."

**[Click Twin mode (the Twin Test scenario loads), make sure 4x is on, press Play]**

> "These two episodes share identical inputs for the first 9 minutes. Watch the beliefs — they're the same."

*Point at the Divergence panel: "pre-split identical" (max difference 0 up to the SPLIT line at 09:00).*

## 0:30 - 1:30 · Twin divergence + Gateway / Rumor

**[Wait for the SPLIT line. Narrate through the wait, it takes about 1 s at 4x per minute]**

> "Watch — same inputs, same beliefs. Now the split... and within a few minutes, the cascade side starts seeing hospital reports the other side doesn't."

*At 13:00 point at Twin A's "Why it changed": "P(cascade) rose from 0.19 to 0.61 because hospital_arrivals_unusual anomalies arrived in z06, and emergency_call_spike anomalies arrived in z01, and the forecast hospital_arrivals_unusual arrived on schedule." Twin B at the same minute: P(cascade) 0.18.*

> "Now they split. The left side gets the hospital surge the forecast predicted — the cascade is spreading. The right side doesn't, and the engine notices the expected hospital reports never showed up. Within 5 minutes of the split the beliefs differ by 0.64. The left side goes to ALERT at minute 14 and ESCALATE at 16; the right side stays at PREPARE and never alerts. Same start, different data, correct call."

**[Pick "Gateway Outage + Rumor Wave" in the scenario menu, press Play at 4x. Pause at minute 6-7]**

> "Now 26 sensors behind one gateway, gw0, all report the same reading: 99.9. A counting baseline would panic — that's 26 alarms, and on this episode it escalates. Our engine sees they're identical, groups them as one broken gateway, and stays calm."

*Point at "Why it changed": "P(sensor_failure) rose from 0.14 to 0.73 because identical readings from gateway gw0 arrived in z02." The top evidence line reads "gateway gw0: 26 sensors report the identical value 99.9 (one unit: a lying gateway)". By minute 7 P(sensor_failure) is 0.97; the action never goes above PREPARE and drops to WATCH at minute 9.*

## 1:30 - 2:15 · Cutout + Learning

**[Pick "Cutout", press Play at 4x. Pause at minute 15]**

> "Mid-episode, gateway gw0 goes silent and 26 sensors go dark. The engine doesn't assume calm — it says 'I've lost coverage' and widens its uncertainty."

*Point at the DEGRADED banner (it says it is a demo threshold: below 80% trust-weighted coverage; coverage is 75%) and at "Why it changed": "Gateway gw0 lost: 26 sensors now dark, confidence widened." Resume: ALERT at 19:00 while half-blind, ESCALATE at 33:00 once the sensors are back.*

> "This scenario uses a demo threshold of 80% so you can see the banner; the eval uses the engine default of 50%."

**[Click Prior-Shift mode, press Play]**

> "Over 100 episodes, monsoon season starts at episode 51. The system learns from each revealed outcome and shifts its prior — more rain, more cascades expected."

*Point at the rising prior line: P(cascade) starts episode 25 at 0.06 and episode 75 at 0.22. Be honest if asked: the CUSUM drift alarm does not fire on this sequence, and the adaptive prior's Brier after the shift (0.401) is no better than a static prior (0.397); see Limitations.*

## 2:15 - 3:00 · Eval + Limitations

**[Click Eval mode]**

> "Against the obvious baseline — count anomalies and panic — our engine cuts false alarms from 35% to 2.5%, improves calibration from 0.72 to 0.41 Brier, and reduces cost by 66%."

*Point at the policy comparison table: count-threshold Brier 0.724, false alarms 34.8%, cost 7.73 per tick; engine (tuned) 0.414, 2.5%, 2.62. 302 test episodes the tuner never saw.*

> "Limitations are on screen and in the README. This is calibrated on synthetic data only. The causal graph is hand-set. Lead time is still negative — cascades and lookalikes look the same until the late stages. We're honest about what it can and can't do."

---

## What changed from the draft script (and why)

The draft quoted example figures. These were replaced with what the dashboard really shows:

| Draft said | Script now says | Why |
|---|---|---|
| "drainage anomalies in new zones" (twin) | hospital reports (`hospital_arrivals_unusual` in z06) | the 13:00 divergence is driven by hospital reports, not drainage |
| "ESCALATE on the left, WATCH on the right" | left ALERT 14:00 / ESCALATE 16:00, right stays PREPARE | the benign twin never drops to WATCH in the episode |
| "within a minute" (twin narration) | "within a few minutes" | first difference > 0.1 is 4 minutes after the split |
| "28 sensors" | 26 sensors (27 a minute later) | the panel says 26 |
| "gateway G3" | gateway gw0 | the lying gateway is gw0 |
| "28 sensors report identical values — gateway G3 correlated, treating as SENSOR_FAILURE" | the real panel sentence (quoted above) | quote the screen, not a paraphrase |
| "monsoon season starts at episode 50" | episode 51 | episodes 1-50 normal, 51-100 monsoon |
| "The system detects the regime change" | "learns ... and shifts its prior" | CUSUM does not alarm on this sequence; the prior does move |
| "first 9 minutes", "cost by 66%", "35% to 2.5%", "0.72 to 0.41" | unchanged | all correct (split at 09:00; 1 - 2.62/7.73 = 66%) |
