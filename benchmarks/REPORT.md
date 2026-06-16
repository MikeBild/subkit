# subkit vs. reference architecture — execution & authoring benchmark

Comparison of the subkit engine + sk-CLI against the reference workflow-automation
implementation, on **execution speed** and **authoring quality + latency**. The reference
was read statically only — never built, started, or executed (it ships usage tracking). All
subkit numbers are reproducible locally (see *How to reproduce*).

## TL;DR

- **Intra-workflow parallelism was a tie, now a win.** Both engines ran `for_each`/loop
  iterations strictly sequentially; the reference parallelizes only *between* workflows (a
  fixed subprocess worker pool), never *within* one. subkit now fans out read-classified
  `for_each` iterations with bounded concurrency: **5.8× faster** on a 24-item GET fan-out
  (1442 ms → 249 ms), measured end-to-end through the real engine.
- **Authoring quality is unchanged (the load-bearing guarantee).** The two authoring
  parallelizations are quality-neutral: the full eval gate (33 fixtures, incl. the
  one-shot-pipeline, for-each-pipeline, and repair-roundtrip authoring contracts) stays green
  with "baseline drift: within gate."
- **Authoring latency dropped on two serial hot spots** by turning `await`-in-a-loop into
  `Promise.all`: GROUND doc-loading ~4.9× and the recorded-eval repair fan-out ~3.0× on their
  scheduling delta.

## Axis-by-axis

### Speed

| Axis | subkit (before) | subkit (after) | Reference | Winner |
|---|---|---|---|---|
| `for_each` / loop fan-out | sequential (1×) | bounded-parallel, auto-selected from read/write class | sequential within a workflow | **subkit** |
| Between-workflow parallelism | pg-boss workers | unchanged | Deno subprocess pool (12) | tie |
| GROUND docs (multi-connector) | N serial doc-searches | `Promise.all` (≈ slowest one) | lazy `search_documentation` tool | **subkit** (fewer round-trips) |
| Repair fan-out | ≤3 serial LLM invokes | `Promise.all` (≤3 concurrent) | n/a | **subkit** |
| HTTP connection reuse | Bun fetch pools by default | unchanged | keep-alive disabled by default | **subkit** |
| Caching (dry-run / JSONata compile) | present | unchanged | docs cache only; no preview cache | **subkit** |

Measured (`benchmarks/`, this machine):

```
for_each execution   items=24 delay=40ms   sequential 1442ms → parallel 249ms   (5.8×)
GROUND doc-loading   5 connectors @60ms     sequential  306ms → parallel  62ms   (4.9×)
repair fan-out       3 sites     @60ms      sequential  183ms → parallel  61ms   (3.0×)
```

The `for_each` parallel run (249 ms) sits above the ideal lower bound (~120 ms) because each
iteration still does its own sequential step-row bookkeeping insert; the win is the network
fan-out, which is where I/O-bound workflows spend their wall-clock.

### Authoring quality

| Axis | subkit | Reference | Notes |
|---|---|---|---|
| First-pass validity / one-shot draft | grounded one-shot pipeline (≤2 generate passes) | multi-pass agentic build | subkit minimizes round-trips by design (Fix A) |
| Content-correct first preview | asserted by `eval:live` + judge | — | guardrail: must stay ≥ baseline |
| Generated-transform correctness | recorded-eval + bounded verified repair | self-correcting loop, no patch-candidate store | subkit keeps a propose-only repair contract |
| Quality regression from this change | **none** — 33/33 eval fixtures pass | n/a | parallelization is purely a scheduling change |

The quality bar for this change is **non-regression**: the two parallelizations must not alter
*what* the pipeline produces, only *how fast*. Evidence: `bun run eval` → `Total: 33  Pass:
33  Fail: 0`, including `authoring-one-shot-pipeline`, `authoring-for-each-js-pipeline`,
`authoring-repair-roundtrip`, and both judge fixtures. GROUND now loads per-connector docs
concurrently but reconstructs the prompt in deterministic connector order, so the generation
prompt is byte-identical to the sequential version.

### Architecture (read statically)

| Axis | subkit | Reference | Winner |
|---|---|---|---|
| Self-healing / patch candidates | drift detection + bounded repair + patch-candidate store | mentioned, not implemented in the read sources | **subkit** |
| Transform model | JS + JSONata (selectors/when/output) | raw JS with `<<expr>>` interpolation | tie (different trade-offs) |
| Grounding strategy | eager one-shot GROUND (samples + docs) | lazy on-demand doc-search tool | tie (round-trips vs. precision) |
| Side-effect classification | one shared seam (HTTP/GraphQL/SQL/S3 + override) | per-strategy | tie — subkit reuses it to gate auto-parallelism |

## What changed in this pass

1. **`for_each_concurrency`** field on `baseStep`; engine auto-selects bounded concurrency from
   the step's side-effect class (`resolveForEachConcurrency`, reusing
   `classifyRequestStepSideEffects`). Read-classified requests fan out; writes/transforms stay
   sequential unless the author opts in. Result order is preserved by index regardless of
   completion order. (`apps/engine/src/execution/engine.ts`,
   `apps/engine/src/workflows/types.ts`)
2. **GROUND doc-loading** runs per-connector excerpts + probe samples concurrently.
   (`apps/engine/src/conversations/authoring-pipeline.ts`)
3. **Recorded-eval repair fan-out** runs its ≤3 verified repairs concurrently, preserving the
   shared deadline signal and the cap logic.
   (`apps/engine/src/conversations/recorded-eval.ts`)

## How to reproduce

```bash
# Execution speed (needs Docker for testcontainers Postgres)
NODE_ENV=test bun run benchmarks/execution-for-each.ts            # --items N --delay-ms MS

# Authoring fan-out scheduling delta
bun run benchmarks/authoring-latency.ts                           # --connectors K --repairs R --task-ms MS

# Authoring quality (the guardrail) — must stay green
bun run eval                                                      # 33 fixtures, deterministic

# End-to-end authoring quality + latency vs a captured baseline (manual, needs a live engine)
bun run apps/engine/eval/live-authoring.ts --engine-url <url> --api-key <key> --baseline <report.json>
```
