# Subkit — Architecture Audit & Simplification Plan (v2)

> Status: revised after operator review on 2026-05-03. Supersedes the prior draft. All counts re-verified against `main`. The reference implementation under `~/Projects/AI/superglue` is referred to as "the reference implementation / ref-impl" only and is **not** treated as an architecture target — its choices are simpler in places, but subkit's heavier shape (typed drivers, tenant scoping, audit, Zod surface, engine/sk/agent split) is intentional control-plane cost.

---

## 1. Summary

Subkit is **directionally healthy**:
- Product boundary is clear and stays within "enterprise AI integration control layer" — not a horizontal automation suite.
- Tenant isolation and audit are first-class.
- OpenAPI is genuinely Zod-first (`apps/engine/src/http/openapi.ts` is **73 LOC** — just the OpenAPIHono shell + metadata; no handwritten spec).
- Execution is deterministic; no live LLM in tests; no snapshot tests.
- Engine/sk/agent split is justified by runtime boundaries.
- 617 test files across the repo (532 under `apps/engine/src/`); 92 runtime + 23 dev dependencies; 9 typed drivers; 90 connector templates.

The remaining complexity risk is **localised**, not foundational:
1. A handful of files >1K LOC.
2. `conversations/` is a god directory at the root level.
3. Token-budget logic is fragmented across 6 files.
4. Four large `http/routes/*.ts` files leak subsystem internals.
5. Open v1.1 recipe-sweep work (#48–#57) risks pulling subkit toward general workflow automation.
6. RBAC, audit, and route-level tests cover the basics but are not matrix-complete.

There is no foundational rework required. The ordering below is **stabilise → close gaps → consolidate → refactor with a safety net → reassess backlog → narrow ops UX migration**.

---

## 2. Critical corrections to the prior draft

The earlier audit drafted off slightly stale exploration data. Corrections:

| Prior claim | Reality on `main` (2026-05-03) | Implication |
|---|---|---|
| `http/openapi.ts` may be a 1000-LOC handwritten spec | 73 LOC, just the OpenAPIHono shell | Zod-first is real. No work needed here. Already corrected in prior §2 / §7. |
| Identity has zero direct test coverage on `service.ts` (771 LOC) | `apps/engine/src/identity/service.test.ts` is **713 LOC** plus `oidc-discovery`, `api-key`, `portal-token` tests | **#61 is closed.** Identity is *not* a P0 hole; targeted matrix-completion still useful. |
| Auth / RBAC / audit / identity are uniformly untested | RBAC has `evaluator.test.ts`; audit has `pool-isolation.test.ts`, `metadata-scrub.test.ts`, `recorders/recorders.test.ts`; auth has `providers/tests/oidc-real.test.ts`; identity has 4 tests | The gap is **matrix completeness**, not absence. Reframe accordingly. |
| Repo has 174 runtime + 23 dev deps and 532 tests | 92 runtime + 23 dev; 617 tests across the repo (532 under `apps/engine/src/`) | The runtime footprint is leaner than I claimed. Multi-provider AI SDK story is fine. |
| #58 (env vars → settings) is v1.0-critical | #58/#59 are labelled **release/v1.1**; v1.0 thin-slice setup already shipped via #60/#70 | Move #58/#59 to the end of the plan. Keep narrow scope. |
| Issues #60, #61, #63 still open | All three closed, alongside #46, #47, #53, #54, #67-#71 | Drop them from the open-work table. |
| Token-budget files total ~773 LOC | ~800 LOC across the same 6 files (count varies a few dozen lines depending on what's pulled in) | Consolidation argument unchanged; numbers immaterial. |

What **stays unchanged from the prior draft** because verification confirms it:
- `conversations/loop.ts` 1811 LOC, `authoring-state.ts` 1552, `service.ts` 1315, `persist.ts` 606 — root is overgrown.
- `execution/steps/request.ts` 1804, `conversations/tools/sdk-wrap.ts` 1803, `llm/core/context-assembler.ts` 1296, `execution/engine.ts` 1045 — four files mix multiple concerns.
- `http/routes/conversations.ts` 1303, `connector-templates.ts` 948, `executions.ts` 865, `notifications.ts` 771 — route god-files.
- 6 token/budget files: `llm/tokens.ts`, `llm/budgets.ts`, `llm/core/token-accountant.ts`, `execution/llm-budget.ts`, `knowledge/budgets.ts`, `docs-ingestion/budgets.ts`.
- 39 top-level subsystems under `apps/engine/src/`.

---

## 3. What to preserve (do not refactor away)

| Strength | Evidence | Why |
|---|---|---|
| Zod-first OpenAPI | `http/openapi.ts` 73 LOC; 45 routes use `@hono/zod-openapi` | Zero-drift surface. Lint against re-introducing handwritten specs. |
| Tenant isolation at every DB query | Per-subsystem grep confirms `tenantId` predicate | Single biggest enterprise differentiator. Lock in via AST lint. |
| Single LLM provider entry point | All LLM calls through `llm/core/invoke.ts` | Multi-provider stays cheap as long as no other file imports `@ai-sdk/*`. |
| No backwards-compat shims | Single baseline migration; no `_v1`/`_v2`; no env-flagged dead code | Continue deleting old code outright when shapes change. |
| Zero snapshot tests | `grep toMatchSnapshot` is empty | Refactoring stays cheap. Hold the line. |
| Test discipline at the right layers | testcontainers for db/http/webhooks; `bun:test` co-located unit; `tests/e2e/` separate; LLM always mocked | Strong layering. Do not soften under schedule pressure. |
| Self-healing as a first-class subsystem | `self-healing/` (2630 LOC) with bounded repair + fixture dry-run | Genuine differentiator. Keep. |
| 39 explicit subsystems with directory-local AGENTS.md | `connectors/AGENTS.md`, `execution/AGENTS.md`, `schema-versions/AGENTS.md`, etc. | Architecture is legible. Make this the contract. |
| `connectors/templates.json` as data | 17K-line catalog, JSON, validation strong | Live-editable, atomic-diff-reviewable. Do **not** split into per-template files. |
| Engine / sk / agent split | Three deployables, three `package.json`s, distinct AGENTS.md each | Justified by runtime boundaries (server / CLI / outbound proxy). Keep. |

---

## 4. The specific simplification targets

Each item: the smell, the cost, the action, the host file. No new subsystems, no new abstractions.

### 4.1 — `conversations/` is a god directory

207 TypeScript files within two levels; root mixes loop control, authoring state, tool policy, persistence, intent detection, onboarding policy, and connector drafting.

**Action — split internally only:**
```
conversations/
  chat/         # loop.ts, abort.ts, resume.ts, turn-routing.ts, turn-helpers.ts, event-sink.ts
  authoring/    # authoring-state.ts, intent-detector.ts, connector-draft.ts,
                # connector-template-intelligence.ts, onboarding-policy.ts
  policy/       # tool-policies.ts, dangerous-tools.ts, elicitations.ts, scope-facts.ts
  persistence/  # already exists; absorb persist.ts and json-patch-apply.ts
  tools/        # already exists; sdk-wrap.ts splits into registry / invoke / schemas
  service.ts    # shrinks to a thin router (target <500 LOC)
  types.ts
  index.ts
```
Subdirectories already exist (`tools/`, `persistence/`, `policies/`, `agent/`); we are finishing a started decomposition, not inventing one. Cross-area calls go through interfaces from `types.ts` only.

### 4.2 — Five files >1K LOC mix multiple concerns

Split structurally, no behaviour change:

| File | LOC | Decomposition |
|---|---|---|
| `conversations/loop.ts` | 1811 | dispatch, mutation, tool-callout, event emission, abort separation |
| `execution/steps/request.ts` | 1804 | `request/dispatch.ts` (driver pick) + `request/retry.ts` + `request/shape.ts` + `request/errors.ts` |
| `conversations/tools/sdk-wrap.ts` | 1803 | `tools/registry.ts` + `tools/invoke.ts` + `tools/schemas.ts` |
| `conversations/authoring-state.ts` | 1552 | state machine + extracted `authoring/validate.ts` + `authoring/preview.ts` |
| `llm/core/context-assembler.ts` | 1296 | extract `skill-picker.ts` + `accounting/prune.ts` (see §4.3); assembler stays as orchestrator |
| `execution/engine.ts` | 1045 | step lifecycle + state mutation separation; reuse existing `state.ts` |

Target: every file fits one screen of cognition. Tests carry over; the existing `conversations/tests/`, `execution/tests/`, `llm/tests/` directories absorb the moves.

### 4.3 — Token / budget logic is fragmented

Four files (~600 LOC total) implement overlapping LLM-token concerns:

```
llm/tokens.ts                  (pre-call counting via tiktoken)
llm/budgets.ts                 (per-tenant monthly DB ledger + limits)
llm/core/token-accountant.ts   (post-hoc reconciliation of SDK usage)
execution/llm-budget.ts        (per-run cap on workflow LLM steps)
```

**Action — collapse into one surface (Phase 3 — landed):**
```
llm/accounting/
  count.ts       # absorbs llm/tokens.ts
  budget.ts      # absorbs llm/budgets.ts
  accountant.ts  # absorbs llm/core/token-accountant.ts
  enforce.ts     # absorbs execution/llm-budget.ts
  index.ts       # public re-exports
```

**Scope correction during Phase 3:** the prior framing also listed
`knowledge/budgets.ts` and `docs-ingestion/budgets.ts` as files to
fold in. On reading the source, those are **byte budgets** for file
storage and HTTP-fetch resource usage — they share only the word
"budget" with LLM-token accounting and have no overlapping logic.
They are intentionally LEFT IN PLACE.

### 4.4 — HTTP route god-files leak internals

Four route files >700 LOC, each importing subsystem internals (e.g. `http/routes/executions.ts` imports `execution/{engine, abort, jsonata-engine, request-meta-schema}`).

**Action — split per sub-resource (not per verb), and enforce a layering rule:**

```
http/routes/conversations/
  index.ts           # registers child routers
  chat.ts
  drafts.ts
  events.ts
  attachments.ts
```
Lint: route files may import from a subsystem's `index.ts` only. Combine with the route-size ceiling (see §6).

### 4.5 — In-memory mutable state without TTL

| Location | Risk |
|---|---|
| `observability/metrics.ts` (`MetricsRegistry`) | Histograms grow with cardinality (per tenant × workflow × connector) |
| `tunnels/registry.ts` | Connection pool keyed by `tunnelId`; no documented eviction |
| `settings/` cache | No invalidation across instances |
| `pubsub/` broker singleton | Module-scoped reference |

**Action — pick the semantically right policy per location**, not a uniform one:
- Metrics → OTLP-pushed and dropped after export.
- Tunnels → bounded LRU with eviction metric.
- Settings → invalidated via PG `LISTEN/NOTIFY` (subkit already has `pubsub/` for this).
- Pubsub broker → documented "process restart" contract; no in-memory state assumed durable.

### 4.6 — Hold the line at one LLM provider entry point

`llm/core/invoke.ts` is the only file that imports `@ai-sdk/*`. Lint to hold this line; otherwise multi-provider becomes 6 places to fix on each SDK change.

---

## 5. Backlog disposition (15 currently open issues, 2026-05-03)

Decision criterion: pays into stated value props (governance, isolation, deterministic execution, conversation-first authoring, audit) — yes/no — and how heavy.

**Stale-issue housekeeping is part of Phase 1.** Anything that no longer reflects reality is closed or re-scoped on day 1, with a comment that links to this document. The full pass:

- **Closed during Phase 1:** #55 (replaced with `templates-backlog` label), #57 (re-opened with snapshot-free framing).
- **Already closed before this plan started — confirmed and removed from any scheduling assumption:** #46, #47, #53, #54, #60, #61, #63, #67, #68, #69, #70, #71. Any remaining references in code comments, README, or docs that point at these issue numbers as "TODO" get cleaned up alongside the move into `docs/audits/`.
- **Re-labelled during Phase 1:** #50 and #52 receive `release/v4` (no work scheduled in this plan); #48 receives `release/v4` *unless* Phase 5 confirms it can stay deterministic.
- **Re-labelled during Phase 5:** #45 receives `release/v2-architecture` (separate plan).

| # | Title (truncated) | Disposition | Why |
|---|---|---|---|
| **#66** | Backlog meta tracking issue | **Repurpose as the rolling status board** for this plan; do not close until all phases land | One source of truth |
| **#65** | Driver coverage for ftp/sftp/mssql/redis/smb | **Phase 2 — implement** | Directly protects "9 typed drivers" promise |
| **#62** | Tighten 30 production non-null assertions | **Phase 2 — fold in opportunistically** | Each coverage push surfaces these naturally |
| **#64** | Bundle `sk` + `tunnel-agent` binaries inside engine image | **Phase 5 — implement** | Operator UX; pairs with the same image-build touch as #58/#59 |
| **#58** | Collapse 55 env vars → runtime settings | **Phase 6 — implement narrowly** | v1.1 work. **Do not** rewrite every env read at once. Use a registry-first migration; preserve the five bootstrap env keys per the issue body |
| **#59** | `sk settings configure` interactive form driver | **Phase 6 — implement after #58 schema** | Reuses `apps/sk/` Ink form patterns |
| **#49** | Wait-for-event (HITL approval gate) | **Phase 5 — implement, audit-first, minimal scope** | Pays directly into governance + audit value props; keep the step kind small and deterministic |
| **#51** | Persistent state (reverse-ETL watermark) | **Phase 5 — implement, audit-first, minimal scope** | Pays into deterministic execution; treat as a single durable step kind, not a general state machine |
| **#48** | Durable wait + until (multi-day dunning) | **Phase 5 — implement only if it stays a deterministic step kind with audit coverage** | Otherwise defer with #50/#52 |
| **#50** | Saga compensation (employee onboarding rollback) | **Defer (release/v4 label)** | Highest overcomplexity risk; pulls subkit toward general workflow automation |
| **#52** | FanOutStep end-to-end | **Defer (release/v4 label)** | Same reasoning as #50 |
| **#56** | Cross-connector scenario chains (Workstream C) | **Phase 5 — implement** | Pays into connector-ecosystem value prop |
| **#55** | Fill 65 zero-recipe templates (Workstream B) | **Close + replace with `templates-backlog` label** | Mechanical work; convert to small batched PRs (5 templates each); the mega-issue is preventing incremental progress |
| **#57** | Quality follow-ups (golden snapshots, intent-match eval) | **Close + re-open with new framing** | "Golden snapshots" conflicts with the no-snapshot-tests stance; re-scope as fixture-based contract tests |
| **#45** | Federate remote MCP capability catalogs | **Defer to v2-level architecture work** (separate plan) | Introduces trust boundary, catalog provenance, RBAC projection, audit semantics. Should not land until the local MCP surface is fully test-guarded |

### 5.1 — Issues to **close** during the audit

- **#55** — replace with a `templates-backlog` label after one PR creates the label and migrates the substance.
- **#57** — re-scope and re-open with a body that matches the no-snapshot stance.

### 5.2 — Issues to **open** as part of this audit (Phase 1 day 1)

| Title | Audit § | Phase | Scope |
|---|---|---|---|
| Architecture guard tests + invariants CI | §6 | 1 | scope/medium |
| Move audit doc into `docs/audits/2026-05-architecture-audit.md` | §7.1 | 1 (day 1) | scope/small |
| PR template: audit-phase fields | §7.5 | 1 | scope/small |
| RBAC permission-matrix tests | §6.2 | 2 | scope/medium |
| Audit immutability / redaction / tenant-filter / source-attribution / txn tests | §6.2 | 2 | scope/medium |
| Route-level RBAC + Zod + audit contract tests for state-changing boundaries (HTTP + MCP) | §6.2 | 2 | scope/large |
| Consolidate token/budget into `llm/accounting/` | §4.3 | 3 | scope/medium |
| Decompose `conversations/` (chat / authoring / policy / persistence) | §4.1 | 4 | scope/large |
| Split five 1K+ LOC files (loop, request, sdk-wrap, authoring-state, context-assembler) | §4.2 | 4 | scope/large |
| Split `http/routes/` god-files into per-sub-resource routers | §4.4 | 4 | scope/medium |
| Bound or invalidate in-memory caches (metrics, tunnels, settings, pubsub) | §4.5 | 4 | scope/medium |

All open with the `audit-2026-05` label. Cross-link into #66.

---

## 6. Quality and test plan

The user's review explicitly requires: **tests + stabilisation + consolidation before adding more; then close gaps; then refactor with a safety net.** This section defines the tests and guards that the rest of the plan stands on.

### 6.1 — Architecture guard tests (Phase 1, before any code moves)

**One workflow** runs on every PR and nightly on `main`. **One set of invariants** — listed below in the order they fire. Failure of any single check fails the whole workflow; merges are gated. This is the consistency contract for the next 9 weeks and beyond.

```yaml
# .github/workflows/audit-invariants.yml
on: [pull_request, schedule]   # nightly cron + every PR
required: true                 # blocks merge to main

checks:
  # structural
  - subsystem_count: tests/contract/subsystem-count.test.ts passes
  - no_new_subsystem: no new top-level dir under apps/engine/src/
  - canonical_subsystem_table: AGENTS.md subsystem table matches
                               apps/engine/src/ directory listing

  # import boundaries
  - ai_sdk_locality: no @ai-sdk/* import outside apps/engine/src/llm/core/
  - jsonata_locality: no jsonata import outside
                      apps/engine/src/execution/jsonata-engine.ts
  - route_layering: http/routes/**/*.ts may only import from a
                    subsystem's index.ts (not internals)

  # size ceilings
  - route_size: no http/routes/**/*.ts > 600 LOC unless in
                apps/engine/.size-allowlist.txt
  - file_size: no apps/engine/src/**/*.ts > 1000 LOC unless allowlisted
               with a written reason

  # safety
  - tenant_filter: AST scan — no drizzle .from(table) without a
                   tenantId predicate (allowlisted system tables only)
  - no_snapshots: no toMatchSnapshot / toMatchInlineSnapshot anywhere
  - no_live_llm: no @anthropic-ai or @ai-sdk import in any *.test.ts

  # coverage (added at end of Phase 2)
  - coverage_floor: per-subsystem line + branch coverage ≥ floor in
                    apps/engine/.coverage-floor.json

  # cadence
  - regression_isolation: tests/journeys/session-*-regression.* run only
                          in the regression CI job, not the inner-loop
                          test:unit target
  - pr_template: PR description contains the audit-phase fields (§7.5)
```

The allowlist files (`apps/engine/.size-allowlist.txt`, `apps/engine/.coverage-floor.json`, `apps/engine/.tenant-filter-allowlist.txt`) are themselves PR-reviewed; adding to them requires a justification line. **All three CI jobs (PR, nightly, release-gate) read from the same workflow file** — there is no second source of truth.

### 6.2 — Coverage gaps to close (Phase 2)

The framing is **matrix completeness AND high line coverage** on safety-critical surfaces. Each subsystem already has at least one focused test; the work is to make the test surface exhaustive at the contract level **and** to lift line coverage to a hard floor that the §6.1 guards then enforce.

**Coverage floors written into `apps/engine/.coverage-floor.json` at the end of Phase 2 (CI fails on regression):**

| Subsystem | Line coverage floor | Branch coverage floor |
|---|---|---|
| `rbac/` | 90% | 85% |
| `audit/` | 90% | 85% |
| `identity/` | 85% | 75% |
| `auth/` | 85% | 75% |
| `credentials/` | 85% | 75% |
| `connectors/drivers/*` | 80% per driver | 70% |
| `execution/` | 80% | 70% |
| `self-healing/` | 75% | 65% |
| `scheduler/` | 80% | 70% |
| `http/routes/*` (per state-changing route) | 100% on the boundary contract (Zod / RBAC / tenant / audit), free-form on the rest | — |

The floors are picked to be tight on safety-critical subsystems (rbac, audit) and lower where I/O dominates (connectors, scheduler). Bumping a floor down requires the same justification process as the size allowlist. Bumping a floor up (good direction) is a free PR.

| Subsystem | Existing | Gap to close |
|---|---|---|
| **rbac/** | `tests/evaluator.test.ts` | Table-driven: role × permission × resource × tenant boundary. Negative cases per cell. |
| **audit/** | `tests/pool-isolation.test.ts`, `tests/metadata-scrub.test.ts`, `recorders/recorders.test.ts` | Immutability under crash-mid-batch, redaction on every actor field, tenant-filtered query, request-source attribution (`api`/`mcp`/`webhook`/`chat`), transaction rollback on failed state changes. |
| **identity/** | `service.test.ts` (713 LOC), `oidc-discovery.test.ts`, `api-key.test.ts`, `portal-token.test.ts` | Targeted matrix completion (JWKS rotation edge cases, JIT provisioning under concurrent first-login, portal token revocation propagation). Not a broad rewrite. |
| **auth/** | `providers/tests/oidc-real.test.ts` | Per-provider negative path (expired, wrong-tenant, malformed), token rotation, provider hand-off ordering. |
| **connectors/drivers/{ftp,sftp,mssql,redis,smb}** | none | One integration test per driver via docker-compose service (closes #65). |
| **HTTP + MCP state-changing boundaries** | individual route tests scattered | A single contract test pattern: every mutation proves (a) Zod rejects bad input → 400, (b) RBAC denies wrong principal → 403, (c) tenant isolation holds → 403 across tenants, (d) audit row written. Generated from a route catalog so new endpoints inherit the contract. |
| **self-healing/** | scattered | Drift detector unit tests; fixture dry-run integration test. |
| **scheduler/reconciler.ts** (770 LOC) | none | Race-condition test: two engines, one schedule, exactly-once fire. |

These eight closures do not require any code refactoring; they slot onto today's surface.

### 6.3 — Test discipline to keep

- `bun:test` only; no Vitest migration.
- `testcontainers` for db/http/webhooks; never mock Postgres or pg-boss.
- LLM provider always mocked; never live.
- No snapshot tests (already guarded in §6.1).
- Regression-tagged journey tests (`tests/journeys/session-*-regression.*`) run in CI but **not** in the inner-loop dev target; tag and isolate.
- No co-located test imports more than 8 internal modules. Forces extract/seam refactors when violated.

### 6.4 — Verification block (re-runnable)

```bash
# Phase 1 closed
bun run tests/contract/subsystem-count.test.ts
bun test apps/engine/src --include="audit-invariants*"

# Phase 2 closed
bun test apps/engine/src/rbac --coverage      # matrix complete
bun test apps/engine/src/audit --coverage     # contracts complete
bun test apps/engine/src/identity --coverage  # matrix gaps closed
bun test apps/engine/src/auth --coverage      # negative paths complete
bun test apps/engine/src/connectors/drivers/  # all 9 drivers covered
bun test tests/contract/route-rbac-zod-audit  # boundary contract test

# Phase 3 closed
test -d apps/engine/src/llm/accounting
test ! -f apps/engine/src/knowledge/budgets.ts
test ! -f apps/engine/src/docs-ingestion/budgets.ts

# Phase 4 closed
test "$(wc -l < apps/engine/src/conversations/loop.ts)" -lt 800
test "$(wc -l < apps/engine/src/execution/steps/request.ts)" -lt 800
test "$(wc -l < apps/engine/src/conversations/tools/sdk-wrap.ts)" -lt 800
test "$(wc -l < apps/engine/src/conversations/authoring-state.ts)" -lt 800
test "$(wc -l < apps/engine/src/llm/core/context-assembler.ts)" -lt 800
[ -d apps/engine/src/conversations/chat ] && [ -d apps/engine/src/conversations/authoring ] && [ -d apps/engine/src/conversations/policy ]

# Final
bun run /verify
```

---

## 7. Tracking cadence

A 7-week plan that lives only in a per-user `~/.claude/plans/` file will rot. The mechanisms below survive engineer churn.

### 7.1 — Single source of truth

Move this audit into the repo as `docs/audits/2026-05-architecture-audit.md` on day 1; link it from `AGENTS.md`. From then on:
- The repo copy is canonical.
- Every PR in any phase cites `docs/audits/2026-05-architecture-audit.md#<section>` in its description.
- Updates are PRs, not silent edits.

GitHub issue **#66** becomes the rolling status board: weekly body update with *Done / In flight / Blocked*; comments hold the per-week verification log.

### 7.2 — Weekly cadence (30 minutes, Monday)

One engineer runs the §6.4 verification block against `main` and posts the output as a comment on #66 in this format:

```
Week N — yyyy-mm-dd
✓ subsystem count canonical
✓ all guard invariants green
✓ rbac matrix complete (Phase 2)
✗ route-level boundary tests 70% complete — blocking Phase 3, see PR #X
Phase 1 status: complete
Phase 2 status: in flight (week 3 of 3)
```

That comment is the only weekly artefact. No standup, no separate doc.

### 7.3 — Phase gates (hard, not aspirational)

| Gate | Closing condition | Blocks |
|---|---|---|
| **Phase 1 complete** | All §6.1 guards live and green; doc moved into repo; PR template updated | Phase 2 start |
| **Phase 2 complete** | All §6.2 closures merged; #65 closed; matrix tests pass | Phase 3 start |
| **Phase 3 complete** | `llm/accounting/` exists; `knowledge/budgets.ts` and `docs-ingestion/budgets.ts` deleted; all callers routed | Phase 4 start |
| **Phase 4 complete** | Five files in §4.2 each <800 LOC; `conversations/` root has ≤3 files (`service.ts`, `types.ts`, `index.ts`); §4.4 routes split; §4.5 caches bounded | Phase 5 start |
| **Phase 5 complete** | #49, #51, #56 merged (audit-first scope); #55/#57 re-handled per §5.1; #50/#52 labelled `release/v4` | Phase 6 start |
| **Phase 6 complete** | #58 lands ≥40 of the 55 env vars in runtime settings; #59 ships; #64 ships; final `bun run /verify` green | Audit closes |

### 7.4 — Anti-drift CI

The §6.1 workflow runs nightly and on every PR. Allowlist files (`apps/engine/.size-allowlist.txt`, `apps/engine/.coverage-floor.json`) are PR-reviewed.

### 7.5 — PR template addition

```
**Audit phase / section:** 1 | 2 | 3 | 4 | 5 | 6 | unrelated
**Section reference:** docs/audits/2026-05-architecture-audit.md#<id>
**Verification touched:** <which §6.4 invariants does this PR move>
```

### 7.6 — "No new subsystem" guardrail

Adding a top-level dir under `apps/engine/src/` requires a PR to `tests/contract/subsystem-count.test.ts` plus a one-paragraph justification explaining why an existing subsystem could not absorb the change. The justification is the artefact; the count change is the consequence.

---

## 8. Phase-by-phase deliverables (full schedule)

The user's preferred order is **stabilise → close gaps → consolidate → refactor with safety net → reassess backlog → narrow ops UX**. Each phase below ends with a measurable gate from §7.3.

### Phase 1 — Stabilisation (week 1)

**Goal:** lock the architecture in place before touching any code structure.

- Move audit doc into repo at `docs/audits/2026-05-architecture-audit.md`; link from AGENTS.md.
- Open the 11 issues listed in §5.2 with the `audit-2026-05` label.
- Land `.github/workflows/audit-invariants.yml` (§6.1).
- Initialise `.size-allowlist.txt` with the current 5 oversize files; `.coverage-floor.json` empty for now.
- Update PR template (§7.5).
- Tag regression journey tests (`tests/journeys/session-*-regression.*`) and route them into a separate CI job, not the inner loop.
- Close **#55** after creating the `templates-backlog` label and migrating the substance.
- Close + re-open **#57** with the snapshot-free framing.
- Sweep code comments, README, and `docs/` for references to #46, #47, #53, #54, #60, #61, #63, #67–#71; remove or re-point as part of the same PR that moves the audit doc into `docs/audits/`.

**Gate:** all §6.1 invariants green; #55 closed; #57 re-opened with new body; no live references to confirmed-closed issues in code/docs.

### Phase 2 — Close safety coverage gaps (weeks 2–3)

**Goal:** make the existing test contract matrix-complete on the safety-critical surfaces.

Week 2:
- RBAC permission-matrix tests (role × permission × resource × tenant).
- Audit contract tests: immutability under crash-mid-batch, redaction, tenant-filter, request-source attribution, transactional rollback.
- Identity matrix-completion tests on `service.ts` (JWKS rotation, concurrent JIT, portal-token revocation).
- Auth provider negative-path tests.

Week 3:
- Route-level boundary contract: a generated test that asserts every state-changing HTTP and MCP boundary obeys (a) Zod rejection, (b) RBAC denial, (c) tenant isolation, (d) audit-row written.
- **#65** — one integration test per driver (ftp, sftp, mssql, redis, smb) via docker-compose. Close #65.
- Self-healing drift-detector unit tests.
- Scheduler exactly-once fire test.
- Fold #62 (non-null assertions) opportunistically as tests force them.

**Gate:** all §6.2 closures merged; `apps/engine/.coverage-floor.json` populated with the §6.2 targets; CI workflow promoted to enforce the `coverage_floor` check from §6.1; #65 closed.

### Phase 3 — Consolidation (week 4)

**Goal:** unify token/budget logic before refactoring depends on it.

- Create `llm/accounting/{count,budget,enforce,index}.ts`; move logic from `llm/tokens.ts`, `llm/budgets.ts`, `llm/core/token-accountant.ts`, `execution/llm-budget.ts` into it.
- Update all callers (`knowledge/`, `docs-ingestion/`, `execution/`, `conversations/`).
- **Delete** `knowledge/budgets.ts` and `docs-ingestion/budgets.ts`.
- One Prometheus counter, one log line, one audit event for budget concerns.

**Gate:** §6.4 Phase 3 invariants pass; verification across LLM-touching subsystems shows one budget surface.

### Phase 4 — Refactor with the Phase 1+2 safety net (weeks 5–6)

**Goal:** structural splits, no behaviour change. The Phase 1 lints and Phase 2 contract tests are the safety net.

Week 5:
- Split `conversations/` root into `chat/`, `authoring/`, `policy/`, `persistence/` (§4.1).
- Decompose `execution/steps/request.ts` (1804 → ≤4 files <500 LOC each).
- Add the >1000-LOC ceiling lint; populate `.size-allowlist.txt` for any remaining holdouts with reasons.

Week 6:
- Decompose `conversations/tools/sdk-wrap.ts`, `conversations/authoring-state.ts`, `llm/core/context-assembler.ts`.
- Split `http/routes/{conversations,connector-templates,executions,notifications}.ts` into per-sub-resource routers (§4.4).
- Bound or PG-invalidate the four §4.5 caches.
- Add the route-file size ceiling lint (600 LOC).

**Gate:** all §6.4 Phase 4 invariants pass; regression journey tests green.

### Phase 5 — Backlog reassessment (week 7)

**Goal:** triage v1.1 recipe-sweep work explicitly; ship only what fits the audit-first criterion.

- Implement **#49** (HITL approval gate) as a deterministic step kind, audit-first, minimal scope.
- Implement **#51** (persistent state / reverse-ETL watermark) as a single durable step kind, not a general state machine.
- Implement **#56** (cross-connector scenario chains).
- **#48** (durable wait + until) — implement only if it stays a deterministic step kind with audit coverage; otherwise label `release/v4`.
- Apply `release/v4` label to **#50** (saga compensation) and **#52** (FanOutStep). Issues stay open; they are valid v4 candidates.

**Gate:** v1.1 recipe issues either merged with audit-first scope, or explicitly labelled `release/v4`.

### Phase 6 — Narrow ops UX migration (weeks 8–9)

**Goal:** ship #58/#59/#64 as small, reviewable steps; do not rewrite every env read.

Week 8:
- **#58** — registry-first migration. Land the runtime-settings schema and migrate ~20 of the 55 env reads in this PR. Preserve the five bootstrap env keys called out in the issue body.
- Add `LISTEN/NOTIFY` invalidation for the new settings cache.

Week 9:
- **#58** continued — migrate another ~20 env reads.
- **#59** — `sk settings configure` lands using existing `apps/sk/` Ink form patterns.
- **#64** — bundle `sk` + `tunnel-agent` binaries inside engine image at `/install/sk-:platform-:arch`.
- Final §6.4 verification block green on `main`. Update #66 with closure status; close it.

**Gate:** #58, #59, #64 merged; final `bun run /verify` green; all `audit-2026-05` issues closed.

### Post-audit (separate plan)

- **#45** (federate remote MCP catalogs) is **v2-level architecture work**; plan separately. Do not pull into the audit.
- **#50**, **#52** (and possibly **#48** if deferred) sit on the `release/v4` label awaiting their own plan.

---

## 9. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Phase 2 matrix-completion reveals a real bug | Medium | Buffer week 3 by deferring opportunistic #62 closures — they can slip without harming the gate. |
| Phase 4 decomposition breaks an undocumented invariant in `loop.ts` or `request.ts` | Medium | The Phase 2 boundary contract test + tagged regression journeys catch this; keep both green during weeks 5–6. |
| #58 narrow migration drags into #59 | Medium | Ship in two PRs (Phase 6 weeks 8 and 9); preserve the five bootstrap env keys per the issue body so the migration is bounded by design. |
| Engineer rolls off mid-plan | Medium-low | The cadence artefact is **issue #66 + the §6.1 CI invariants**; a new engineer resumes from the last green Monday checkpoint. |
| v1.1 recipe-sweep stakeholder pushes for #50/#52 | Low | §5 has the value-prop justification. Phase 5 is the explicit triage moment. |
| Audit doc drifts from reality | Low (lives in repo, referenced from PRs) | Weekly Monday checkpoint catches drift within 7 days. |
| Architecture guards block legitimate work | Low | Guards have allowlists; allowlist edits are PR-reviewed with a written reason. The lint exists to slow the path of least resistance, not to block. |

---

## 10. Closed-loop automation design

The plan can be driven as a **mostly-autonomous closed loop**, with the §6 tests and §6.1 CI workflow as the only validation. About 70% of the work is fully automatable; the remaining ~30% has explicit "stop" conditions where the loop files a tracking issue and pauses for human input rather than degrading the safety net.

### 10.1 — Loop architecture

```
LOOP (per phase):
  1. Pick the next PR-sized change toward the current phase gate (§7.3).
  2. Generate the change in a feature branch.
  3. Open PR. PR template auto-filled with audit-phase fields (§7.5).
  4. CI runs (every PR, gating merge):
     - All §6.1 invariants
     - Coverage floors from §6.2 (after Phase 2)
     - Full test suite: bun:test unit + integration + e2e
     - Type check, lint, format
     - Determinism check
     - Terminology check (`bun run check:terminology`)
  5. If green AND no STOP signal raised (see §10.3):
     a. Auto-merge to main with squash commit.
     b. Append the §7.2 verification-block output as a comment on #66.
     c. Loop to step 1.
  6. If red:
     a. Read CI output.
     b. Generate fix in the same PR (max retry budget: 3).
     c. Loop step 4.
  7. If retry budget exhausted OR a STOP signal raised:
     a. Park the PR with `audit-blocked` label.
     b. File a "needs-human" issue describing the obstacle and the
        last green main SHA.
     c. Move to the next independent change in the phase.
PHASE GATE:
  - Re-run §7.3 closing condition.
  - If pass: advance phase. Loop continues.
  - If fail: STOP at phase boundary, post status to #66.
```

### 10.2 — Per-phase automation level

| Phase | Automation level | Why |
|---|---|---|
| **1 — Stabilisation** | **Full** | Pure scaffolding: add CI workflow, add lints, move doc, update PR template, close stale issues with templated comments. No semantic decisions. |
| **2 — Close coverage gaps** | **High (with a self-check)** | Test generation is templatable from the route catalog (boundary contract test) and from RBAC enum × resource enum (matrix). The loop's *own correctness* is validated by mutation testing: introduce a deliberate behaviour change in the SUT; if the generated tests don't catch it, the loop adds more before claiming the gap is closed. #65 driver tests are generated from a docker-compose template. |
| **3 — Consolidate LLM accounting** | **High** | Mechanical file moves + import rewrites with `tsc --noEmit` + tests as the safety net. Pre-condition: Phase 2 coverage floors hold so behaviour changes are caught. |
| **4 — Decompose god-files** | **Medium** | Splitting `loop.ts` into chat/authoring/policy needs semantic placement decisions. Loop generates a candidate split, runs tests, then runs an AST diff to assert the public exports of `conversations/index.ts` are byte-identical pre/post. If the AST diff is non-empty, the PR auto-fails before CI even runs. |
| **5 — Backlog reassessment** | **Mixed** | Labelling and closure are full-auto. Implementing #49/#51/#56 is feature work; the loop generates a skeleton PR and STOPS, asking for product/scope input on the step kind shape. |
| **6 — Narrow #58/#59/#64 migration** | **High** | Mechanical env-var → settings registry conversion, one PR per ~5 keys, with the five bootstrap keys hard-coded in the allowlist. `sk settings configure` form is generated from the Zod schema. |

### 10.3 — Hard STOP signals (loop must pause, not degrade)

The loop is **forbidden** from working around any of these, even if the change would otherwise be mechanical:

1. **Adding to `.size-allowlist.txt`** — the loop may never widen the size allowlist. If a generated change pushes a file over 1000 LOC, the loop must split first, not allowlist.
2. **Lowering a value in `.coverage-floor.json`** — the loop may only raise floors, never lower them.
3. **Adding to `.tenant-filter-allowlist.txt`** — tenant-filter exemptions are security-sensitive; humans only.
4. **Creating a new top-level dir under `apps/engine/src/`** — the §6.1 `no_new_subsystem` lint blocks this and the loop must not edit `subsystem-count.test.ts` to compensate.
5. **Importing `@ai-sdk/*` outside `llm/core/`** — same: the loop may not edit the lint config to allow the import.
6. **Editing `tests/journeys/session-*-regression.*`** — these tests pin behaviour; the loop must change code so they pass, not change them so the code passes.
7. **Suppressing a CI check** (`# noqa`, `// eslint-disable`, `bun:test only`) — bans this entirely.
8. **Force-pushing to `main`** or **bypassing required CI** — never.
9. **Reaching the retry budget on a single PR** — pause and file an issue.
10. **Recipe-sweep step-kind design decisions** in Phase 5 (#48, #49, #51, #56) — generate skeleton, then STOP for product input.

These are listed in `apps/engine/.audit-loop-policy.md` and the loop reads them at startup. The same file is referenced from #66.

### 10.4 — Self-validation: how the loop knows it didn't lie

Tests are necessary but not sufficient — a loop that generates a PR with no tests will pass CI vacuously. Three cross-checks:

1. **Mutation testing on generated tests.** After Phase 2 lands, the loop runs `stryker` (or equivalent) weekly against the safety-critical subsystems. If the mutation score on `rbac/`, `audit/`, `auth/`, `identity/` drops below 80%, the loop pauses Phase 2 work and raises a "tests are not catching mutations" issue.
2. **AST diff on Phase 4 splits.** Public exports of every refactored subsystem (`conversations/index.ts`, `execution/index.ts`, `llm/index.ts`) must be byte-identical pre/post split. The loop runs `bunx tsc --emitDeclarationOnly` before and after; any diff fails the PR.
3. **Behaviour-equivalence assertion.** For Phase 3 (LLM accounting consolidation), the loop runs a fixture-driven replay: 100 prerecorded LLM conversations through the OLD and NEW code paths; token counts and budget decisions must match exactly. Recorded under `tests/fixtures/llm-accounting/`.

### 10.5 — Operator override surface

Even in fully-autonomous mode, the operator has three levers without taking the system out of closed-loop:

1. **Comment `/audit pause` on #66.** Loop drains in-flight PRs and stops at the next phase boundary.
2. **Comment `/audit skip <change-id>`** on a parked PR. Loop closes the PR and moves on.
3. **PR-level label `audit-loop-keep-open`.** Loop will not auto-merge that PR even if CI is green; treats it as a human-owned PR.

Anything beyond that (changing phase order, lowering a coverage floor, adding to size allowlist) is a regular PR reviewed by the operator. The loop reads but does not write those files.

### 10.6 — What the loop physically is

A simple driver script + a scheduled GitHub Actions workflow:

```
.github/workflows/audit-loop.yml          # runs every 30 minutes on main
apps/engine/scripts/audit-loop/
  policy.md              # the §10.3 STOP list
  state.json             # current phase, last green SHA, retry budgets
  next-change.ts         # decides what PR to open next
  generate.ts            # produces the diff (uses LLM under llm/core/)
  validate.ts            # runs the §10.4 self-checks locally
  open-pr.ts             # gh pr create with the audit-phase template
  watch.ts               # polls CI; on green, merges; on red, generates fix
```

The loop's own LLM calls go through `llm/core/invoke.ts` with a budget enforced by `llm/accounting/` (after Phase 3) — eating its own dogfood. Every loop action is recorded in `audit/` with `request_source = "audit-loop"`, so the operator has a full forensic trail.

### 10.7 — Risk-bounded answer

**Yes**, the plan can run as a closed loop for the majority of its 9 weeks **provided** the §10.3 STOP list is enforced and the §10.4 self-checks are wired up before Phase 4 begins. The 30% that requires human input is not an automation failure — it is the design choice that prevents the loop from silently lowering the safety floor to make itself look productive.

---

## 11. One-line summary

> Subkit is structurally healthy. Stabilise the architecture with guard tests; close the matrix gaps in RBAC / audit / drivers / route boundaries; consolidate token accounting into `llm/accounting/`; then refactor `conversations/` and the five 1K+ LOC files with the safety net in place; reassess v1.1 recipe-sweep against the audit-first criterion; and only after all of that, run the narrow runtime-settings migration. Six bounded phases, ~9 engineer-weeks, no foundational rework.
