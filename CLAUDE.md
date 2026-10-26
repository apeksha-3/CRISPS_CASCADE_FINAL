# CLAUDE.md

1. Read `docs/SPEC.md` first. It is the full spec (requirements R1-R12).
2. We build in phases (0-6). Each phase ends at a gate: run it, show real output, stop. Do not start the next phase until asked.
3. Keep code simple: small files, plain-language comments on the math, readable by beginners.
4. Never add heavy dependencies. Runtime: `express` only. Dev: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/express`.
5. No LLM anywhere in the engine's decision loop. Explanations are template sentences.
6. The engine (`/engine`) must never import ground truth (`GroundTruth` lives in `sim/truth.ts`, simulator and eval only).
7. After every phase gate passes: write the phase report, commit, and push to the current phase branch (Phase 7: `phase-7-real-data`, Phase 8: `phase-8-real-hardening`, Phase 9: `phase-9-nowcast`). No PRs, no force-push, no AI attribution lines in commits.
8. `engine/` never imports `sim/` (a test scans every engine file for static, dynamic and require imports).
9. The naive baseline lives in `engine/baseline.ts` and is reused later as the FALLBACK (R11). Keep it pure, small and dependency-free.
10. Time is whole seconds since episode start; one tick = 60 s. Simulator seeds: dev 1000+, test 5000+, prior-shift 8000+. Tune only on dev.
