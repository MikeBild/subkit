---
name: subkit-self-healing
description: Work on drift detection, bounded repair loops, patch candidates, schema-version tracking, or Execution Fixture dry-runs in subkit. Use whenever the task touches apps/engine/src/self-healing/, schema-versions/, or adjacent logic that proposes (but does not auto-apply) fixes.
---

# subkit Self-Healing

> **Project context:** Before starting work, read `AGENTS.md` at the repository root.

Self-healing detects drift between the runtime and the last known Connector
endpoint schema, runs a bounded LLM repair loop, dry-runs the result against an
Execution Fixture, and writes a **Patch Candidate** for operator approval.

It never auto-applies. That is a contract, not a default — do not add code paths
that bypass it.

## Canonical references

- `docs/06-execution.md` — Self-healing, drift detection, bounded repair loop, Execution Fixtures, versioning.
- `docs/07-security-governance.md` — Audit expectations for proposal and approval.
- `docs/04-authoring.md` — LLM tool-use loops (self-healing reuses the same primitives).

## Loop contract

1. **Drift signal.** An Execution Step fails with a diff signal (response shape
   doesn't match last Schema Version). Emitted from `execution/` via
   `observability/`.
2. **Context refresh.** Pull the latest Connector docs via `docs-ingestion/`. If
   the external system's schema has changed, that alone may explain the drift.
3. **LLM repair loop.** Bounded: max iterations, max tokens, interrupt budget.
   Tool-use over a restricted tool set (`propose_patch`, `validate_patch`,
   `run_in_fixture`).
4. **Dry-run.** The candidate patch executes against an **Execution Fixture**
   (recorded prior successful execution). Pass/fail/partial recorded.
5. **Patch Candidate written.** To `self-healing/` persistent store. Status:
   `proposed`. Includes diff, dry-run result, confidence, reason.
6. **Operator approval.** Explicit action (API / CLI / chat) promotes the patch
   to `applied` (status change + audit entry + runtime activation). Operator can
   also reject or defer.
7. **Audit every phase.** Drift detection, loop start, dry-run outcome, approval,
   application.

## Non-negotiables

- **Never auto-apply a patch.** Always a Patch Candidate first, always operator
  approval to promote.
- **Never run a candidate patch outside the sandbox.** QuickJS-WASM with interrupt
  budget.
- **Never skip the Execution Fixture dry-run.** If no fixture exists, the
  candidate is `proposed_without_dry_run` — operator must explicitly accept.
- **Bounded loop.** Max iterations, max tokens, max wall-clock. Termination is a
  first-class requirement.
- **Audit at every phase.** Drift detection, repair start, each iteration summary,
  dry-run result, approval decision, application.
- **Redaction applies.** Candidate JS may reveal connector request/response
  shapes — do not log raw credentials.
- **Fixtures are tenant-scoped.** Don't reuse across tenants even when the
  Connector template matches.

## Adding or changing repair behavior

1. Read `docs/06-execution.md` (self-healing and versioning sections) first.
2. Find the phase you're changing (drift detect, context refresh, LLM loop,
   dry-run, candidate write, approval).
3. Preserve the six-phase flow. If your change would collapse or skip a phase,
   stop — that's an architectural change requiring `domain-architect`.
4. Token-budget accounting goes through `llm/` (see the observability skill).
5. Write tests:
   - Unit for the pure parts (diff computation, fixture matching, confidence
     calculation).
   - Integration for the full loop against a seeded drift scenario + mock LLM.
   - Always test the *failure* path: loop hits the iteration cap, dry-run fails,
     fixture missing. Self-healing failing gracefully is the main contract.

## Interaction with other subsystems

- **`skill-candidates/`** — also a "proposed, human-approved" subsystem. Do not
  merge them; they track different things (repair patches vs. pattern-derived
  skills).
- **`docs-ingestion/`** — refresh step pulls from here. If ingestion is stale,
  the repair loop will chase a moving target.
- **`execution/`** — emits the drift signal. The patch, once applied, changes
  how a Step behaves at runtime.

## Things not to do

- **Never auto-apply.** Repeated for emphasis — this is *the* contract.
- **Never run the repair loop unbounded.** Iteration cap, token cap, wall-clock
  cap, all required.
- **Never call a real LLM in tests.** Use the mock provider.
- **Never skip the audit trail.** An unapproved patch that shows up in
  production without an audit chain is a critical bug.
- **Never log the candidate JS plaintext without redaction.** Patches may embed
  request shapes that include credential references.
