# Evidence process — verifying a behavioral / LLM-path change

How to prove a change to an LLM-driven path (authoring generation, the preview
judge, repair loops) actually does what you claim — with real evidence, not
intuition. This is the discipline behind the v7.9.0 format-aware-judge work; it
caught a wrong self-diagnosis mid-flight (see the worked example below).

> **Rule:** evidence MUST be confirmed by real tests. Never state that a metric
> moved unless a test or the benchmark shows it. Separate "logic verified by a
> unit test" from "end-to-end outcome verified by the benchmark", and report
> both states honestly.

## The loop

1. **State the thesis precisely.** One falsifiable sentence — "the grounding
   rule makes single-shot `author_workflow` emit a markdown table as the final
   output". Vague theses can't be refuted.

2. **Instrument first.** Add structured `logger` lines at every decision point
   of the change *before* you trust it — a greppable `action` name plus the
   deciding fields. These stay in the code so the failure class is findable
   later. Examples shipped in v7.9.0:
   - `authoring_pipeline.output_format_grounded` — `{ named_format }`
   - `preview_judge.format_check` — `{ named_format, matched, failed_checks }`
   - `preview_judge.format_mismatch` — emitted on a `passes→partial` downgrade
   - `oauth2.refresh_skipped_needs_reauth` — the F1 short-circuit

3. **Two tiers of tests, both real.**
   - **Deterministic unit tests (no LLM)** for the *logic* — this is the
     load-bearing "verified". Mock the LLM seam
     (`getMockProvider().generateOverrides.<flow>`), feed hand-built inputs,
     assert the decision. See `apps/engine/src/conversations/tests/preview-judge.test.ts`
     and `output-format.test.ts`.
   - **Live benchmark (real LLM)** for the *end-to-end metric* —
     `benchmarks/authoring/` boots the engine on the working tree, drives a
     real authoring conversation, scores the targets, and analyzes the log.

4. **Read the logs and the raw output — not the intent.** Grep the engine log
   for your instrumented actions. Inspect the *actual* tool output, not what the
   code "should" produce:
   - `benchmarks/authoring/out/new.engine.log` — the structured log.
   - `benchmarks/authoring/out/new.report.results.json` — the **raw
     per-scenario tool outputs** (the model's actual `dry_run_workflow` result).
     This is ground truth for "is the final output really a markdown table?".

5. **A/B a thesis.** To test whether a change improves a metric, run the same
   scenario on two code states and compare — no env feature-flag, the variants
   are two git states.
   - **Committed path** (works in any clone): the eval driver takes a
     `--baseline`:
     ```
     bun run eval:live --engine-url <A> --api-key <k> --scenario <slug> --out a.json
     bun run eval:live --engine-url <B> --api-key <k> --scenario <slug> --out b.json --baseline a.json
     ```
     It prints per-metric OLD-vs-NEW changes (regressions flagged).
   - **Local convenience wrapper** (`benchmarks/authoring/`, gitignored —
     review scaffolding, not in the repo; reconstruct from its README): boots
     two throwaway engines + DBs around the above so you don't manage them by
     hand:
     ```
     BENCH_OLD_REF=HEAD BENCH_SCENARIOS=weather-ranking-table ./run.sh delta
     ```
     OLD runs in an isolated git **worktree** (`BENCH_OLD_REF`, default `HEAD^`),
     NEW on the working tree. NEVER `git stash` to switch states on a shared
     checkout — the wrapper uses a worktree for exactly this reason.

6. **Distinguish verified vs not — explicitly.** A divergence between a
   unit-verified decision and the e2e metric is a *finding*, not noise.

7. **Diagnose the divergence before "fixing" it.** When unit-verified logic
   doesn't move the e2e number, the gap is one of:
   - **a measurement artifact** — the test and the code read different
     corpora/fields → fix the *benchmark*, not the product; or
   - **stochastic generation** — the LLM is probabilistic; one run is weak
     evidence, run several; or
   - **a real defect the test didn't cover** — widen the test.
   Name which one. Do not bolt on speculative code to chase a number
   (benchmarks are review scaffolding; permanent regressions go in unit tests).

## Worked example (v7.9.0, format-aware judge)

The first conclusion was "the benchmark's `content_pass=false` is a measurement
artifact — the judge logged `format_check matched:true`, so generation IS
producing markdown". The evidence loop refuted it:

- Added the raw-results dump (`run.sh` step 4 above) and inspected the actual
  `dry_run_workflow` output: **6.5 KB, zero pipes, zero separator row** — the
  final output the caller receives genuinely is NOT a markdown table.
- So `content_pass=false` was *correct*, and the real defect was: generation
  rendered markdown in an intermediate step (which the judge's `step_artifacts`
  view saw → `matched:true`), but a later `output_transform` discarded it, so
  the FINAL output isn't markdown — and the judge, evaluating step artifacts,
  was blind to the final-output transform.

The log + raw-output inspection turned a confident wrong answer into the right
diagnosis. That is the entire point of the process.

## Files

Committed (available in any clone):
- `apps/engine/eval/live-authoring.ts` — the eval driver (`bun run eval:live`);
  writes the scored report + the sibling `*.results.json` raw dump, and A/B-compares
  with `--baseline`.
- `apps/engine/eval/live-report.ts` — `LIVE_SCENARIOS` + scoring + content checks.

Local-only (gitignored review scaffolding — reconstruct from the README, do not
expect it in a fresh clone):
- `benchmarks/authoring/run.sh` — `bench` (current tree) | `delta` (A/B vs ref);
  boots throwaway engine(s) + DB around `eval:live`.
- `benchmarks/authoring/analyze-log.mjs` — log verdict (CLEAN / REVIEW / ISSUES).
