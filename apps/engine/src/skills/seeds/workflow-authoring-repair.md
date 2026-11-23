---
slug: workflow-authoring-repair
scope: global
title: Repairing And Editing Saved Workflows
description: Repairing a failed or saved workflow in chat: diagnose and recommit, metadata-only edits, `step_patches` by step ID, recorded-evidence gates for transforms, workflow-level guards, flow pitfalls and provider tool palettes.
activates_when: [{"kind":"tool","tool":"edit_workflow_patch"},{"kind":"tool","tool":"dry_run_transform"},{"kind":"tool","tool":"update_workflow"},{"kind":"tool","tool":"diagnose_latest_execution"},{"kind":"tool","tool":"propose_schema_migration"},{"kind":"tool","tool":"inspect_workflow_draft"},{"kind":"tool","tool":"suggest_jsonata_paths"},{"kind":"tool","tool":"validate_draft"},{"kind":"diagnosis","codes":["llm_tool_schema_invalid"]},{"kind":"intent_keyword","word":"repair"},{"kind":"intent_keyword","word":"reparier"},{"kind":"intent_keyword","word":"fix the workflow"},{"kind":"intent_keyword","word":"fehlgeschlagen"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow, repair]
version: 1
---

# Repairing And Editing Saved Workflows

## Repair-in-chat: failed run → diagnose → recommit

A persisted workflow that fails does NOT need a new draft. Stay in
chat; the same tools repair in place:

1. **Read the failure** — the `run_workflow` result has `error.code`,
   `error.message`, failing `step_id`, captured response shape. Do not
   paraphrase the error away.
2. **`diagnose_latest_execution`** — pulls causal trace; do not guess from the bare error.
3. **Edit the offending step** — `edit_workflow_patch` covers every targeted change: set a single field or header (`replace /steps/N/...`), replace a step body, add or retarget an edge (`add /edges/-`). For schema drift on a request step, `probe_connector` first; if the connector's response shape changed over time, call `propose_schema_migration` (returns a structured rename/add/remove/widen plan against the recorded shape ledger) before deciding how to patch the transform. A saved workflow is changed with `edit_workflow_patch`, however many operations that takes: `author_workflow` regenerates the whole definition and keeps only what the goal restates, so guards and safety checks in the saved version disappear silently. It refuses a workflow this conversation is bound to, and there is no override: patches can replace every step, so any redesign is expressible. If a patch keeps failing, fix what its error names instead of switching tools.
4. **`validate_draft`** — re-runs structural checks (rarely needed; see below).
5. **`dry_run_workflow`** — preview the patch. In `auto`, a green judged run may commit inline. In `ask`/`plan`, call `save_workflow_draft` after `save_required: true`; the structured human gate decides. Any structural change must run dry-run first.

Do not instruct the user to run a CLI commit (no CLI fallback exists). Do not re-run the failed workflow before re-validating (overwrites the diagnosis). Do not skip failing steps with `if: false` unless the user asks for that behaviour. After three failed repair iterations on the same error, stop and ask the user.

## Metadata-only edits — `update_workflow`, never the build/preview cycle

Changing an EXISTING workflow's **description, display name, or
lifecycle/archive** (and nothing about its steps) is a metadata edit. Call
`update_workflow` directly with the workflow `id` and only the field(s) that
change. It writes the `workflows.description` column (the source of the
`wf_<slug>` tool description), does NOT roll a new version, and needs NO
draft, dry_run, or `save_workflow_draft`. **Do not run or preview the
workflow to change its description** — editing text is never a reason to
execute. Resolve the `id` first via `find_workflow` / `get_workflow`.

If the edit is gated by a confirmation, attach
`commit_intent: { kind: "update_workflow_metadata", payload: { id, description } }`
to `ask_user_confirm` so the approval persists the change directly (no second
tool call). `update_workflow` is metadata-only: if the draft also has STEP
edits it refuses with `uncommitted_step_edits` — commit those via
`save_workflow_draft` first. Step / schema / trigger changes always go through
the draft + `save_workflow_draft`, never `update_workflow`.

## Target existing steps by ID

For a field change inside an existing top-level step, prefer `edit_workflow_patch` with `step_patches: [{step_id, op, path, value}]`. The path is relative to that step, e.g. `/s3/scope` or `/expression`. The engine resolves the stable ID against the current draft, so you must not count numeric positions from a long workflow or use a `config` wrapper. Use ordinary `patches` only for workflow-level structure changes. Never mix the two forms. Both use the same validation and inert-draft persistence gates.

For request steps, use the current flattened shape: `connector_id`, `method`,
`path`, `query`, `headers`, `body`, and `graphql` live directly on the step.
Do not wrap them in `config`.

## Evidence-gated authoring

**Evidence-gated authoring.** A transform that reads `$scope.<X>`
(or `input.scope.<X>` in JavaScript) needs recorded preview
evidence for X. The evidence is **fingerprint-keyed**: it survives
edits to OTHER steps and goes stale only when X's own definition
changed since the last dry-run (gate reason
`preview_stale_for_referenced_step`). Enforcement differs by tool:

- BOTH authoring tools — `author_workflow` and `edit_workflow_patch` —
  ACCEPT the mutation and return a `recorded_eval` findings block in the
  same result: per-expression compile/eval status (caret-pointed JSONata
  errors; sandboxed JS evaluation), scope-reference evidence states
  (recorded / stale / missing), the transform gate verdict,
  `missing_evidence`, and ordered `next_actions`. Read it — acceptance
  is not proof the expressions resolve. Probed connectors count as
  shape evidence.
- `edit_workflow_patch` never REFUSES an edit with missing/stale
  evidence: it accepts the edit and surfaces the
  `transform_authoring_requires_inspect` verdict as a NON-BLOCKING
  `recorded_eval` finding, so the model repairs on the next call instead
  of thrashing on an identical retry. The fix is unchanged — dry-run once
  to record the shape, then re-apply.

Recovery is one round-trip, never a rebuild: call `dry_run_workflow`
once so the engine records `scope_at_step` for the changed step, then
retry the SAME edit — unchanged steps keep their evidence, so one
dry-run per genuinely-new shape suffices. Then call
`suggest_jsonata_paths` (returns ranked path candidates against the
recorded preview, with fallback to the last committed version's
`scope_index` and the most recent execution when no fresh draft
preview exists) or `inspect_workflow_draft` (returns each step's
preview side-by-side with config). Authoring a `for_each` selector against
the LLM's mental model of the API instead of the recorded preview is
how 4–9× retry spirals start.

**Same rule for `transform` steps.** A transform whose expression
cites a sibling X (`$scope.<X>` in JSONata, `input.scope.<X>` in JS)
with missing or stale evidence is surfaced the same way: both authoring
tools accept the edit and report it in
`recorded_eval` as a NON-BLOCKING `transform_authoring_requires_inspect`
finding (no tool hard-refuses it any more). Same fix: `dry_run_workflow`
once, then author the transform against the recorded `output_preview`
(visible via `inspect_workflow_draft`). Hard-coding placeholder
strings (`"item 1"`, `"unknown"`) as defaults to dodge the gate is
forbidden — that's how the "succeeded with garbage output" transcript
happened (`get-last-3-gmail-messages with human output`).

**Iterating on a transform — prefer `dry_run_transform`.** Once a green
`dry_run_workflow` has recorded the upstream step's `output_preview`,
further edits that only touch a transform's `expression` should call
`dry_run_transform` — *not* `dry_run_workflow`. `dry_run_transform`
evaluates the expression (JSONata or JS) against the recorded sample
without re-hitting the network, so a transform debug loop costs O(1) ms
per iteration instead of O(s) and avoids burning vendor rate-limit on
the same upstream call twelve times in a row. Pass the previewed scope
path (e.g. `$scope.fetch_issues`) as `sample_data`; the tool resolves it
from the latest cached dry-run. Only fall back to `dry_run_workflow`
when you actually change a request/connector step or a `for_each` selector, or after several
green transform iterations to confirm end-to-end.

**Validation is auto-surfaced; you rarely need `validate_draft`.**
Every authoring turn's context block already includes a
`- Validation: N errors` section with the field paths. Calling
`validate_draft({})` to re-check what you just read is loop-detected
(the tool is no longer exempt from the per-tool repeat cap). Reserve
it for forcing a re-check after a change applied OUTSIDE the
conversation (operator hand-edit, external import).

**Bare-path step refs are validated.** Forms like `fetch_users.data`
(no `$scope.` prefix) are equivalent to `$scope.fetch_users.data`
and are validated identically. A typo in the leading identifier is
rejected at authoring time with `workflow_unresolved_step_reference`.

**`output_transform` / `output_transform_function` references are
validated too.** Same rule: every `$scope.<id>...` and bare
`<id>....` reference in the workflow-level transform must point at a
real step.

**`authoring_scope_changed` warning fires when consecutive dry-runs
lose paths.** If a step previously published `data.results[*].email`
and the next dry-run no longer surfaces that path (e.g. an upstream
API silently dropped a field), the warning lists every removed path
so downstream transforms / `for_each` selectors can be re-checked before re-
committing. The check is skipped when the workflow draft was
structurally rewritten between dry-runs (mutation_seq guard).

**Catalog discovery.** Use `find_workflow` / `find_connector` /
`find_skill` (free-text keyword search across the saved catalogs)
before reaching for `list_workflows` / `list_connectors`. They are
faster for tenants with more than ~50 workflows or connectors and
return ranked matches in one call.

**`author_workflow` and `edit_workflow_patch` return `persistence: "draft_only"`.**
Neither auto-saves — the fields make this explicit so the LLM never
assumes a workflow is committed before the green, judged preview.

**Scope vocabulary survives commits.** After every successful run
the engine writes `step_id → scope_at_step` to
`workflow_versions.scope_index`. Repair-author sessions opening
months later have `suggest_jsonata_paths` populated from this
persisted vocabulary even before the first dry-run.

## Workflow-level execution guards

These controls live at the workflow root, beside `steps`; they are not step
parameters and must not be hidden in `description`:

- **`max_llm_tokens_per_run`** — positive integer cap for cumulative prompt
  plus completion tokens across all model steps and provider calls in one run.
  Use a `model` step for model work; raw request steps to a model provider are
  also capped and accounted against this limit and the workspace spend limit.
  Set it on every model-backed workflow whose safe cost ceiling is known.
- **`timeout_ms`** — positive integer wall-clock timeout for the workflow run.
- **`validation_function`** / **`validation_expression`** — fail-closed final
  output invariants. Pick the JavaScript or JSONata form, not both.
- **`runtime`** — versioned runtime metadata such as `stdlib_version`; preserve
  existing values when editing a saved workflow.

`inspect_workflow`, `edit_workflow_patch`, draft validation, and
`save_workflow_draft` preserve these fields. If the operator asks to set one,
patch the actual top-level field and verify it in the inspected draft; a prose
mention does not enforce anything at runtime.

## Common pitfalls

- **Hand-assembling a new workflow step-by-step.** Initial authoring
  is ONE `author_workflow` call (the grounded pipeline builder); use
  `edit_workflow_patch` only for targeted edits afterwards.
- **Skipping `probe_connector` or `call_connector` before `author_workflow`.**
  The pipeline generates against guesses. A missed probe is the highest-
  leverage source of authoring failures — verified across 364 dry-run
  retries in one session. Probe every connector, call the primary
  endpoint, then author. No exceptions.

## Provider-compatible tool palettes

The conversation palette checks every native, saved-workflow and external tool's
root input schema before sending it to a model. MCP workflow aliases use the same compatibility rule. Incompatible root combinators are
omitted without weakening or rewriting the underlying business schema. Saved
workflows remain available through `run_workflow` with their original validated
input. Do not repair this by deleting valid `oneOf` constraints from a workflow or
by suppressing all execution tools in a prompt. Tool-schema rejection is reported
as `llm_tool_schema_invalid`, not a network outage. Follow the precise diagnostic
and repair the tool definition or provider adapter rather than retrying unchanged.

## See also

- `subkit-concepts` — the envelope and placeholder tokens.
- `data-handling.md` — JSONata cheatsheet and reshaping patterns.
- `error-recovery.md` — recovering from tool errors mid-conversation.
