# Review Plan — Authoring-Loop Stability + Full Estate JS Migration (subkit 6.19.1 → 6.19.3)

> **Audience:** an automated code/architecture reviewer (Codex / ChatGPT) with repo access but
> **no conversation context**. This document is self-contained: it states what changed, why, the
> contracts each change must honor, the residual risks, and an ordered review checklist with
> concrete questions. Cite `file:line` in findings.
>
> **Repo:** subkit (Bun + TypeScript workflow engine; Hono HTTP, PostgreSQL/drizzle, pg-boss,
> Anthropic LLM, multi-tenant). Start from `AGENTS.md`. Engine lives in `apps/engine/`.
> **Branch reviewed:** `main`. **Commits in scope (oldest→newest):**
> `4be64678` (6.19.1) → `7892cdfa` + `8aa19d0d` (6.19.2) → `b7fbcd73` (6.19.3).
> **Runtime fact:** the engine ships as a single binary via `bun build --compile` (no
> `node_modules` at runtime) and is deployed to a DigitalOcean droplet behind
> `subkit-api.mikebild.dev`.

---

## 0. Executive summary (what to review)

Three landed workstreams plus one data-only operation:

1. **WASM packaging fix (6.19.1, `4be64678`)** — JS transforms (`language:"javascript"`, QuickJS)
   failed on *every* compiled deploy because the WASM was loaded from a separate file absent in
   the single-file binary. Switched to a base64-inlined singlefile variant; added a `--smoke`
   gate that fails the release if a JS transform can't run.
2. **Authoring-loop stability (6.19.2, `7892cdfa`)** — `author_workflow` could stall for ~15 min
   and emit ~19 tool calls. Four packets: per-call LLM timeout (P1), bounded repair fan-out (P2),
   monotonic judge circuit-breaker + verdict memoization (P3), turn budget + no-progress stop (P4).
3. **base64 stdlib primitive (6.19.3, `b7fbcd73`)** — the QuickJS sandbox installs no host
   globals (`btoa`/`Buffer` absent), so JS transforms could not produce the base64 a Gmail `raw`
   field or a GitHub commit `content` needs. Added `sk.base64Encode` / `sk.base64UrlEncode`,
   byte-identical to jsonata `$base64encode`.
4. **Estate JS migration (data-only, no repo diff)** — all 19 transform-bearing *active*
   production workflows in tenant `d10a5f1d` were rewritten from JSONata transforms to JavaScript
   via the engine's HTTP API (`PUT /v1/workflows/{id}`), validated by a transform-level
   equivalence oracle. **Review the *method and its guarantees*, not repo code** (there is none);
   §6 specifies what to scrutinize.

The eval-validator fix `8aa19d0d` is a small but important correctness item (the CI signal that
guards the judge breaker).

**Overall review question:** *Are these changes correct, contract-preserving, free of new tenant-
isolation / determinism / token-budget regressions, and do the safety mechanisms actually bound
the failure modes they claim to?*

---

## 1. Background & product constraints (non-negotiable invariants)

These are repo-wide rules; flag any change that violates them.

- **Tenant isolation.** Every DB read/write is tenant-scoped. There is an audited invariant
  (`bun run audit:invariants` → `tenant_filter`) that rejects a drizzle `.from(table)` without a
  `tenant_id` predicate. Any new query must carry it.
- **Determinism in tests + transforms.** `bun run test:determinism` forbids `Date.now()` /
  `Math.random()` / argless `new Date()` in test code. The QuickJS stdlib file documents "no
  Date.now, no Math.random, no host I/O" as a design guarantee. (Note: the sandbox *does* expose
  the ES `Date` constructor at runtime — see §4/§5 — which is intentional for transforms but
  must never leak into tests.)
- **No backwards-compat shims.** subkit is pre-production; old code is deleted outright and all
  callers migrated in one change. A reviewer should *not* ask for deprecation aliases.
- **No env-based feature flags.** New behavior ships unconditionally; tests are updated rather
  than toggled by `process.env`.
- **Token budget.** Every LLM call routes through `apps/engine/src/llm/core/invoke.ts` and is
  tenant-budget-accounted by `flow`. New LLM call sites must declare a `flow` and ride the budget.
- **Single-binary runtime.** No code may assume `node_modules`, a writable FS, `process.env.HOME`,
  or a separate asset file is present at runtime (the WASM bug was exactly this class).
- **Zod-first HTTP.** Routes are defined with `createRoute` + Zod schemas; request/response shapes
  must round-trip (OpenAPI drift is gated by `bun run check:openapi-drift`).

---

## 2. Workstream A — WASM packaging fix (6.19.1, `4be64678`)

**Files:** `apps/engine/src/sandboxes/quickjs/runtime.ts`, `apps/engine/src/index.ts`,
`package.json`, `bun.lock`.

**Problem.** `runtime.ts` loaded QuickJS via `getQuickJS()` from `quickjs-emscripten`, which fetches
a sibling `.wasm` file. Under `bun build --compile` that file is not embedded, so `runJs(...)`
threw ENOENT on the droplet — i.e. **100% of JavaScript transforms failed in production** while
passing in dev/tests (where `node_modules` exists).

**Fix.** Import `@jitl/quickjs-singlefile-cjs-release-sync` (WASM base64-inlined into JS) +
`newQuickJSWASMModuleFromVariant` from `quickjs-emscripten-core`; build the module from the
inlined variant. `index.ts` gained a `--smoke` path that runs a representative JS transform
(`runJs({code:"return input.scope.v.data * 2;", input:{scope:{v:{data:21}}, input:null}})`) and
exits non-zero unless the result is `42` — wired into the release so a future WASM-embed
regression fails *before* deploy.

**Review focus / questions.**
- Confirm `runtime.ts` no longer references any file-loaded WASM path and that module
  construction is synchronous-safe and cached (no per-call re-instantiation cost regression).
- Is `--smoke` reachable in the release pipeline (`.github/workflows/release.yml`) and does its
  exit code actually gate deploy? Confirm it also covers the `sk.*` stdlib (it should, since the
  same sandbox boot installs it).
- Cross-platform: the build compiles binaries for multiple targets (incl. windows-x64). Does the
  singlefile variant embed correctly for every compiled target, or only the host arch?
- Memory: base64-inlined WASM increases binary size and resident set. Cross-check against the
  documented droplet OOM history — is the steady-state RSS still within the configured caps?

---

## 3. Workstream B — Authoring-loop stability (6.19.2, `7892cdfa`)

**Symptom.** `author_workflow` (a one-shot pipeline: ground → generate → recorded-eval + bounded
repair → emit draft, followed by the conversation loop's dry-run → judge → commit) could (a)
**stall** ~15 min on wedged provider calls + unbounded repair fan-out, and (b) be **chatty**
(~19 tool calls) because the judge/repair loop never converged or stopped.

Four packets (P1–P4). Files below; **read each affected line** (the repo rule is: do not review
expression/assembler/loop code from intuition).

### P1 — Per-call LLM timeout
**Files:** `apps/engine/src/llm/core/ai-sdk-model.ts`, `invoke.ts`, `base-types.ts`.
- `LLM_CALL_TIMEOUT_MS = 90_000`; `buildCallSignal(timeoutMs, callerSignal?)` =
  `AbortSignal.any([caller, AbortSignal.timeout(...)])`, applied in `callWithFallback` so the
  ceiling bounds **both** primary and fallback round-trips; `AbortError` → typed
  `LlmCallAbortedError`. `SubkitLlmObjectGeneratorInput` / `SubkitLlm.generateText` gained an
  optional `signal?: AbortSignal`, threaded through `invoke.ts`.
- **Questions.** Does *every* provider round-trip in the submit/abort tool loop get the merged
  signal (not just the first)? Is the timeout applied per-call (correct) rather than per-turn
  (would silently truncate legitimate multi-step work)? Are caller-abort vs timeout-abort
  distinguishable downstream (telemetry, retry classification)? Confirm no `Date.now`/`setTimeout`
  crept into tests (`ai-sdk-model.test.ts` was rewritten to use `queueMicrotask` for determinism).

### P2 — Bounded repair fan-out + pipeline deadline
**Files:** `authoring-pipeline.ts`, `recorded-eval.ts`, `transform-repair.ts`, `dry-run-repair.ts`.
- `PIPELINE_DEADLINE_MS = 120_000` threaded into generate + recorded-eval; `GeneratedWorkflowSchema`
  steps `.max(25)` (was 50). `MAX_PIPELINE_REPAIRS = 3`, `MAX_REPAIR_FINDINGS = 3`; >3 findings ⇒
  skip site-repair and set `report.repair_skipped`. `dry-run-repair.ts` enforces the **same**
  aggregate `repairBudget = MAX_PIPELINE_REPAIRS` across all sites (incl. the `output_transform`
  repair), decremented per repaired site. Graceful degradation: on deadline, emit best-draft +
  note rather than throw.
- **Questions.** Is the repair budget truly an *aggregate* per dry-run (not per-finding-type) so a
  pathological workflow can't multiply LLM calls? On deadline, is the partially-built draft always
  persisted (so the user keeps progress) and is the note actionable? Does `repair_skipped`
  propagate to the envelope the model sees, or can the model loop unaware it was capped?

### P3 — Judge circuit-breaker + verdict memoization
**Files:** `preview-judge.ts`, `preview-judge-gate.ts`, `authoring-state.ts`,
`authoring-state/normalize.ts`, `types.ts`, `dry-run-workflow.ts`.
- Breaker state changed from `{fingerprint, blocks}` to **`{blocks_since_commit, last_verdict}`** —
  a **monotonic per-draft** counter that increments on every block *regardless of fingerprint
  change* and resets to 0 **only on commit** (`bindPersistedWorkflow`, `authoring-state.ts:~741`).
  After `JUDGE_BREAKER_MAX_BLOCKS = 2` the verdict degrades to advisory (auto-commit proceeds) and
  the result carries a terminal `judge_done`/done-signal so the model stops re-running.
  Memoization: an unchanged re-preview (same `workflowDefinitionFingerprint`) reuses
  `last_verdict` and **skips the judge LLM call**. `normalize.ts` tolerates the legacy
  `{fingerprint, blocks}` shape on read.
- **Cross-goal safety (review finding F1 in the original work):** the breaker is cleared on goal
  change (`applyWorkflowMutation`: `priorGoal !== nextGoal ⇒ state.judge_breaker = null`) and in
  `startNewWorkflowDraft`, so a pivoted goal can't inherit a stale breaker and advisory-commit a
  wrong first draft.
- **Questions.** Is "monotonic, reset-only-on-commit" the right anti-churn invariant, or can a
  legitimate multi-edit convergence get advisory-committed too early at cap=2? Is the memoization
  fingerprint **whole-definition** (correct, since the judge evaluates output) and collision-safe
  (sha256[:16] of canonical JSON)? Does the advisory-commit path *always* surface the unmet
  `missing[]` to the user (governance: an advisory-committed wrong workflow must be visible)?
  Verify `normalize.ts` legacy tolerance can't silently zero a live counter.

### P4 — Turn budget + no-progress stop
**Files:** `loop/model-resolver.ts` (+ test), `loop/stop-conditions.ts` (+ test), `loop.ts`.
- `DEFAULT_BUDGET` 50 → **24** (per-turn SDK step cap). New `noProgressRepairStopCondition` +
  `MAX_STALLED_REPAIR_PREVIEWS = 3`: stops on 3 consecutive `dry_run_workflow` calls with an
  identical `requires_repair` + sorted missing/warning set.
- **Questions.** Is 24 empirically sufficient for the hardest legitimate authoring task (the
  benchmark showed happy paths at 6–8 calls — but what is the *worst* good case)? Could the
  no-progress detector false-positive when the model is making real but slow progress that
  happens to keep the same warning set? Is the stop surfaced as actionable guidance, not a silent
  halt?

**Behavioral evidence already gathered (for context, re-derive if doubtful):** post-deploy
benchmark — simple workflow 50s/8 calls, droplet-specs 68s/6 calls, no stall; the journal showed
*none* of `LlmCallAborted` / `PIPELINE_DEADLINE` / `noProgressRepair` / `worker_expired` /
`MemoryHigh` firing, i.e. the loop converges naturally and the caps are backstops.

---

## 4. Workstream C — eval-validator alignment (`8aa19d0d`)

**Files:** `apps/engine/eval/validators/authoring-judge-gate.ts`,
`apps/engine/eval/validators/authoring-judge-breaker.ts`.

The CI-mode eval scenarios (run by `bun run verify:ai`) still asserted the **pre-P3** breaker shape
(`judge_breaker.blocks`, and a "counter frozen at cap" expectation). P3 renamed the field to
`blocks_since_commit` and made the advisory auto-commit **reset** the breaker. Updated the
validators: per-draft monotonic counter, and the post-cap advisory auto-commit clears the breaker
(`judge_breaker === null`).

**Questions.** Do these validators now pin the *actual* P3 contract (not just "make it pass")?
Specifically: block 1 → `blocks_since_commit===1`, block 2 → `===2`, third identical preview →
advisory + auto-commit + breaker reset to null. Is there a scenario that pins the *memoization*
skip (no judge LLM call on unchanged re-preview) and the **goal-change reset**? If not, that's a
coverage gap to flag.

---

## 5. Workstream D — base64 stdlib primitive (6.19.3, `b7fbcd73`)

**Files:** `apps/engine/src/sandboxes/quickjs/stdlib/stdlib.js` (+ `.d.ts`),
`stdlib/tests/encoding.test.ts`, `stdlib/tests/drift.test.ts`.

Added `sk.base64Encode(input)` and `sk.base64UrlEncode(input)` to the frozen `sk` global. Stdlib
version bumped **1.0.0 → 1.1.0** (minor; same-major ⇒ no drift for recorded workflows per
`stdlib/drift.ts`).

**Critical semantic decision (review carefully).** The engine's jsonata `$base64encode` is
**byte-per-char / Latin-1** ("each character is one byte = its low 8 bits"), **not UTF-8**. The
helper was deliberately implemented to match jsonata *exactly* (`charCodeAt(i) & 0xff` per code
unit) so a transform can move from jsonata to javascript **byte-for-byte unchanged**. `base64Url`
keeps `=` padding and substitutes `+`→`-`, `/`→`_` (the prevailing
`$replace($replace($base64encode(x),'+','-'),'/','_')` idiom). The `encoding.test.ts` locks this
by comparing the QuickJS runtime against the jsonata runtime on ASCII, umlauts, symbols, and the
Gmail MIME shape.

**Questions / risks.**
- **Is matching the Latin-1 quirk the right call?** It is *faithful* (no behavior change for
  migrated email/commit workflows) but it propagates a latent mojibake bug: non-ASCII in a
  `charset=utf-8` MIME is mis-encoded. The decision was "faithful migration now; UTF-8 correctness
  is a separate, explicit follow-up." **Confirm this is documented and intentional**, and consider
  whether a *second* clearly-named `sk.base64EncodeUtf8` should exist for new authoring so the
  estate doesn't standardize on the quirk. (This is the single highest-value architectural
  question in the base64 change.)
- Surrogate pairs / astral code points: `& 0xff` on a UTF-16 unit silently mangles them — does
  jsonata do the same? The test asserts equality on a `✓` (U+2713) case; confirm coverage for an
  actual astral/emoji input if any workflow could carry one.
- Is the `sk` object still frozen and non-enumerable after the addition? Any new helper must not
  break the `no host I/O / determinism` guarantee (base64 is pure — confirm).
- Does the LLM-authoring skill (`conversations/seed/skills/workflow-authoring.md`) advertise the
  new `sk.base64*` surface so the pipeline proposes it? The stdlib README says the skill must stay
  in sync — **flag if it was not updated.**

---

## 6. Operation E — Estate JS migration (data-only; review the method)

**No repo diff.** All 19 transform-bearing active workflows in tenant
`d10a5f1d-1b2d-496e-ad45-f904c0b61d68` were rewritten from JSONata transforms to JavaScript and
committed as new versions via `PUT /v1/workflows/{id}` (instant rollback via
`POST /v1/workflows/{id}/restore/{version}`). The reviewer should assess **the migration method,
its faithfulness guarantee, and the engine contracts it relied on** — and verify those contracts
in the code.

**Method:** deterministic, semantics-preserving JSONata→JS rewrite, gated by a **transform-level
equivalence oracle**: evaluate the original jsonata and the candidate JS against the *same real
recorded scope* using the engine's own runtimes (`apps/engine/src/execution/jsonata-engine.ts`
`evaluate`/`compile` + `apps/engine/src/sandboxes/quickjs/runtime.ts` `runJs`), and require
deep-equal output before any `PUT`. Loop-reading transforms (whose recorded scope is lossy — see
below) were validated end-to-end (`O_old` vs `O_new`) or on realistic 0/1/2-element scopes.

**Engine contracts the method depends on — verify each in code:**

1. **Step transform JS context** (`execution/steps/transform.ts:~442`): `runJs({code, input:{scope,
   input}})`. So authored JS reads `input.scope.<id>.data`, `input.input`, and `return`s. Confirm
   this is the exact shape and that `scope[id]` is the `{data, status_code?, headers?, …}` envelope
   (jsonata `$scope.<id>.data` and JS `input.scope.<id>.data` must address identically).
2. **`output_transform_function` context** (`execution/engine.ts:~913`): `runJs({code,
   input: lastOutput})` — **only `lastOutput`, no `scope`/`input` bindings**, unlike step
   transforms. And `lastOutput === scope.<lastStep>.data` after the final step
   (`engine.ts:~420-421`). The migration relied on this to (a) **drop** redundant
   `$scope.<lastStep>.data` output_transforms, (b) translate `$scope.<lastStep>.data.X` OTs to
   `return input.X;`, and (c) **relocate** OTs that reference `$input` or other steps into a final
   transform STEP (which has the `{scope,input}` context). **Verify the two-context asymmetry is
   real and that `lastOutput` is exactly the last step's `scope_value`** — the entire OT-migration
   correctness hinges on this.
3. **`output_transform` ⊕ `output_transform_function` mutual exclusion** (`workflows/types.ts:~1085`
   superRefine). The PUT bodies set exactly one. Confirm the validator rejects both-present.
4. **`PUT` preserves the trigger** (`http/routes/workflows.ts` `CreateBody` is `.passthrough()` and
   carries `trigger`). Historically a PUT *stripped* triggers and unbound schedules; the migration
   relied on the fix. **Verify the schedule for `publish-ready-essays` (cron `3 8 * * *`,
   Europe/Berlin) survives a version rotation** — i.e. `applyTriggerBindings` runs on PUT and the
   `workflows_schedules` row is re-bound, not orphaned.
5. **Loop aggregation scope shape.** A loop step's *recorded* `output_preview` stores the loop's
   `over`-items, **not** the nested per-iteration bodies; at *execution* time `$scope.<loop>.data`
   is the array of `{<bodyStepId>:{data:…}}`. The migrated JS assumes the execution shape. Confirm
   the execution-time shape matches what the JS reads (`input.scope.<loop>.data[i].<bodyStep>.data`).

**JSONata→JS faithfulness traps the migration handled — sanity-check the reasoning:**
- `data{...}` = object-grouping (→ object of arrays); `data.{...}` = map (→ array of objects);
  `^(>k)` = descending sort. (jsonata **singleton collapse**: a 1-element `.{}`/`[$x].{}` yields a
  scalar/object, not a 1-array — the migration reproduced this where it could fire.)
- `x.y.z` over an empty array ⇒ jsonata **omits** the key (undefined); a single match ⇒ scalar;
  many ⇒ array. The DigitalOcean and publish-ready transforms reproduce omit/scalar/array exactly.
- `$string(object)` = JSON string (≈ `JSON.stringify`), **not** JS `String(obj)` ("[object Object]")
  — the linkedin OT fallback uses `JSON.stringify`.
- `$now()` → `new Date()` (sandbox `Date` is available); `$base64encode` → `sk.base64Encode`
  (Latin-1, §5).

**Residual risk to flag (the migration's own admitted gaps):**
- `publish-essay-to-github` and `publish-ready-essays` were **not executed** post-migration (they
  perform real GitHub commits / emails). Their transforms were proven byte-identical *offline*
  against recorded/synthetic scope; behavior is argued unchanged because the **write steps are
  untouched**. A reviewer should decide whether "transforms byte-identical + write steps unchanged"
  is a sufficient faithfulness proof for a side-effecting workflow, or whether a hold-writes dry-run
  comparison of the materialized payloads is warranted before trusting the next scheduled run.
- The github-family object-grouping transforms were validated on multi-item real data (e.g. 100
  repos); the **jsonata singleton-collapse edge** (org with exactly 1 repo) is *not* exercised by
  that data. Confirm whether any of those workflows can realistically receive a single-item list
  and, if so, whether the JS reproduces the scalar-vs-array collapse.
- `loop over` / `branch when` / `validation_expression` remain JSONata **by design** (no JS option;
  they are control-flow, not transforms). Confirm this is acceptable scope for "estate on JS."

---

## 7. Cross-cutting review dimensions

Run these lenses across **all** changed files:

1. **Tenant isolation** — any new query carries a `tenant_id` predicate; no cross-tenant leakage in
   the judge/repair/breaker state (breaker lives on the per-draft `authoring-state`).
2. **Determinism** — no `Date.now`/`Math.random`/argless `new Date()` in tests; transform-runtime
   `Date` use is intentional but must be justified per workflow (only `berlin-weather*` uses it).
3. **Token budget** — the judge call (`flow:"judge"`) and all repair calls ride `invoke()` and are
   budget-accounted; confirm the new timeout/abort path doesn't double-charge or leak a call that
   isn't recorded in the audit.
4. **Audit & governance** — auto-commit on green dry-run records `auto_persist_on_green_dry_run`
   with the judge verdict in `extraAuditMetadata`; an advisory (breaker-degraded) commit must be
   auditable as such. Confirm.
5. **Error typing / never-throw** — `judgePreview` must never turn an infra blip into a blocked
   commit (returns `{verdict:"skipped", reason:"judge_unavailable"}`); the pipeline degrades
   gracefully on deadline. Confirm no new throw escapes to fail an otherwise-good turn.
6. **Schema/OpenAPI drift** — `signal?` additions are runtime-only (not serialized); confirm no
   route schema changed without `check:openapi-drift` passing.
7. **Test seams** — egress fakes must go through the driver-fetch seam, not `globalThis.fetch`
   (`no_global_fetch_stub_in_tests` invariant). Confirm new tests comply.

---

## 8. Suggested review order (fan-out friendly)

Each item is independently reviewable; a multi-agent reviewer can parallelize §A–§E then run §7
as a final cross-cutting pass.

1. **§2 WASM fix** — packaging correctness + `--smoke` gate reachability (highest blast radius:
   gates every deploy).
2. **§5 base64 semantics** — the Latin-1-vs-UTF-8 decision + skill-doc sync (highest *design*-risk).
3. **§3 P1 (timeout)** then **P2 (fan-out)** — the stall fix; verify the caps are sound and
   per-call/aggregate as claimed.
4. **§3 P3 (breaker)** + **§4 eval validators** — the chattiness fix + its CI signal; verify the
   monotonic/reset invariant and that the validators pin the real contract.
5. **§3 P4 (budget/stop)** — convergence vs false-positive stops.
6. **§6 migration method** — verify the two transform-execution contexts (`engine.ts:~913` vs
   `transform.ts:~442`), `lastOutput` identity, trigger-preservation on PUT, and judge the
   "byte-identical transforms ⇒ faithful side-effecting workflow" argument.
7. **§7 cross-cutting** — tenant/determinism/budget/audit/drift sweep over the full diff.

## 9. Quality gate status (reproduce, don't trust)

`bun run verify` chains: lint → typecheck → terminology → invariants → drift checks → determinism →
`bun test apps/ packages/` → `verify:ai` → `build:sk` → `test:e2e`. Last local run: **10085 pass /
1 fail**, the 1 fail being `apps/engine/src/credentials/oauth2/tests/wait.test.ts` — a 30s-timeout
test that exceeds its budget under the run's concurrency and **passes 10/10 in isolation**
(documented local-concurrency flake, unrelated to these changes; the same commit passed the full
gate in GitHub CI). `verify:ai` (AI eval contract) is **32/32**. A reviewer should re-run
`bun run verify:ai` and `bun test <touched suites>` and treat any *new* non-flaky failure as a
finding.

---

## 10. Concrete deliverables expected from the review

1. Per-§ findings with `file:line` citations and severity (blocker / major / minor / nit).
2. An explicit verdict on the two highest-risk design calls:
   (a) base64 **Latin-1 faithfulness** vs introducing a UTF-8 variant for new authoring;
   (b) the **"transforms byte-identical ⇒ side-effecting workflow faithful"** argument for the two
   un-executed write workflows.
3. Coverage-gap list (esp. judge memoization + goal-change reset pins; singleton-collapse edges).
4. Confirmation (or refutation) that the four stability caps (P1 timeout, P2 fan-out, P3 breaker,
   P4 budget/stop) each bound their stated failure mode without throttling a legitimate task.
