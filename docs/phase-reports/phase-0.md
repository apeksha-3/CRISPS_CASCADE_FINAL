# Phase 0 report: scaffold

Commit `f0e1d94 phase 0: scaffold` on local branch `claude/project-thread-0n9xmi` (not pushed).

## Gate (real output)

```
$ npx tsc --noEmit
exit=0

$ npm test
 RUN  v5.0.5 /home/claude/CRISPS
 Test Files  2 passed (2)
      Tests  4 passed (4)
exit=0

$ npm run sim / eval / dev
sim: not implemented yet (Phase 1)
eval: not implemented yet (Phase 1)
dev server: not implemented yet (Phase 5)

$ npm audit
found 0 vulnerabilities
```

## (a) Final tree

```
.gitignore  CLAUDE.md  README.md  package.json  package-lock.json  tsconfig.json
config/     causal-graph.ts costs.ts knobs.ts likelihoods.ts transitions.ts trust-priors.ts
dashboard/  index.html
docs/       SPEC.md
engine/     types.ts adapter.ts validate.ts log.ts dedupe.ts cluster.ts filter.ts
            decide.ts forecast.ts learn.ts explain.ts fallback.ts
eval/       harness.ts metrics.ts baselines.ts
server/     index.ts
sim/        truth.ts episode.ts noise.ts scenarios.ts
tests/      smoke.test.ts no-truth-import.test.ts
```

## (b) How to run

```
npm install
npx tsc --noEmit     # or: npm run typecheck
npm test             # vitest
npm run sim          # placeholder until Phase 1
npm run eval         # placeholder until Phase 1
npm run dev          # placeholder until Phase 5
```
Needs Node 22.12+ (vitest 5 requirement).

## (c) Three concepts

1. **Event vs tick vs episode.** An *event* is one message from one source ("drainage sensor D7 anomaly, occurred 3.2, arrived 4.1"). A *tick* is one simulated minute: the engine looks at every event that has arrived so far and outputs one TickRecord (probabilities, action, forecast, explanation). An *episode* is one whole story, about 20-30 ticks, with one hidden true answer. Eval runs ~200 episodes; learning happens between episodes.
2. **Why the engine rebuilds from the event log every tick.** Events arrive late, out of order, duplicated, or get retracted. If we updated belief incrementally, a retraction of something counted 5 minutes ago would mean "un-doing" math, which is error prone. Instead we keep every event in a log and, each tick, recompute belief from scratch using only events with arrived_at <= now. Late events and retractions are then handled automatically, and future isolation (R8) is one filter line we can test. Past *actions* are never rewritten; we only log "this late event would have changed tick 6".
3. **Why GroundTruth is hidden from the engine.** The simulator knows the answer (it's a cascade, gateway G2 failed, this report is a rumor). If the engine could read any of it, even by accident, our scores would be fake and judges would be right to reject them. So truth lives in `sim/truth.ts`, only `/sim` and `/eval` import it, and a test (`tests/no-truth-import.test.ts`) fails if any `/engine` file imports from `sim/`. Learning after an episode receives only a plain outcome label passed in by the harness.

## (d) Assumptions

- **GroundTruth, Episode and the hidden source fields live in `sim/truth.ts`, not `engine/types.ts`.** You asked for them in engine/types.ts, but putting truth inside /engine makes "the engine never imports truth" impossible to enforce. `engine/types.ts` has the public `SourceRegistryEntry`; `sim/truth.ts` has `SimSourceEntry extends SourceRegistryEntry` with `true_reliability` and `clock_offset`. Easy to move back if you prefer.
- Upgraded to current versions to get 0 audit warnings: express 5.3, vitest 5.0, tsx 4.23, typescript 5.9, @types/express 5, @types/node 22. The older ones (vitest 2, express 4) installed with 6 vulnerabilities, 2 critical.
- ESM with `moduleResolution: "Bundler"`, so imports have no `.js` extension; tsx runs them directly. `noEmit` is set, there is no build step.
- Time is a plain number of simulated minutes since episode start (not ISO strings). The adapter will convert other formats.
- Added `retraction` as an EventKind and `gateway` / `utility` / `camera` as SourceTypes; added `changes` and `quarantined_ids` fields to TickRecord for R7 and R5.
- Config values other than the cost matrix are placeholders (flat likelihoods, sticky transitions, base rates 0.60/0.15/0.17/0.08, trust priors by source type). They are clearly marked "hand-set, tune later".
- Added one extra test (engine never imports sim/) because it is the cheapest proof of R8's "never reads ground truth" half.
- Added a `typecheck` npm script as a shortcut for `tsc --noEmit`.
- Commit author is "Claude <noreply@anthropic.com>" with a co-author line; no git identity was configured.
