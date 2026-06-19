# Conversational Flow — Stable End-to-End Replay

This document captures the canonical happy-path transcripts for the three
core authoring flows in `sk` after the inline auto-persist contract landed.
Treat each transcript as the contract: if a real session diverges from one
of these shapes, the divergence itself is the bug to fix.

The contract these transcripts express, in one paragraph: a green
verification step IS the persistence step. A green `probe_connector_draft`
saves the connector inline (audit reason `auto_persist_on_green_probe`). A
clean `dry_run_workflow` commits the workflow inline (audit reason
`auto_persist_on_green_dry_run`). The only happy-path use of `commit_intent`
is the OAuth2 client_id/client_secret form-submit, which still goes through
the harness auto-persist (audit reason `auto_persist_on_confirmation`).

---

## Flow A — Bearer connector creation (Jira, GitHub, custom HTTP API)

```
› you   create a new workflow that loads my jira tickets from acme.atlassian.net

• sk    Setting up a Jira connector for acme.atlassian.net first.

✓ Connector draft ready · acme-jira · http · dev · auth=basic
  Need: Atlassian email + API token (https://id.atlassian.com/manage-profile/security/api-tokens)

› you   email=mike.bild@siemens.com, token=***

✓ Endpoint check complete · GET /rest/api/3/myself · dev · HTTP 200 · 739ms
✓ Connector saved · acme-jira (audit reason: auto_persist_on_green_probe)

• sk    acme-jira saved. Which issues should the workflow load?
        - all tickets assigned to me
        - open tickets in a specific project
        - a custom JQL query
```

What changed vs. the old flow: the `approve · Save Acme Jira
connector` step is gone. The probe envelope returns the saved-connector
shape directly, the lifecycle line reads "saved", and the next prompt
points the operator at the next decision (workflow scope) without a
"what's now?" stall.

Operator action count: **1** form submit (credential).
Audit rows written, in order:
1. `conversation.probe_connector` (result: success)
2. `connector.created` (reason: null)
3. `connector.created` (reason: `auto_persist_on_green_probe`, source:
   `harness_auto_persist`, commit_intent_kind: `save_connector`)
4. `credential.created`

---

## Flow B — Workflow creation with auto-commit on green dry-run

Continuing from Flow A:

```
› you   all tickets assigned to me

✓ Workflow draft ready · my-jira-tickets · 1 step
  GET /rest/api/3/search/jql → transform (key, summary, status, assignee, updated)

✓ Preview complete · 1 step · 21 tickets · no warnings
✓ Workflow committed · my-jira-tickets v1 (audit reason: auto_persist_on_green_dry_run)

• sk    my-jira-tickets v1 is live. Run it now to verify?
```

If the operator says "yes" the assistant calls `run_workflow` directly. The
workflow is saved before the prompt fires; "yes" means "run it", not
"commit it".

Operator action count: **1** decision (issue scope). Compare to the
previous "yes — yes — commit this" three-message loop.
Audit rows written, in order:
1. `execution.started` (source_kind: `draft`)
2. `execution.completed` (result: success)
3. `workflow.created` (reason: null)
4. `workflow.created` (reason: `auto_persist_on_green_dry_run`, source:
   `harness_auto_persist`, commit_intent_kind: `save_workflow_draft`)

---

## Flow C — Workflow run with warning surfaced inline

```
› you   run my-private-github-repos

✓ Execution complete · succeeded · v1 · 1 warning
  16 private repos returned. Transform step dropped 74 fields per repo
  (kept: name, full_name, private, html_url, description, updated_at).
  Run diagnose_latest_execution if the dropped fields matter.

• sk    My-private-github-repos returned 16 repos. The transform projects 6
        of GitHub's 80+ fields per repo — intentional. Want the dropped
        fields?
```

What changed: the run-workflow envelope now carries a `warning_summary`
field that the assistant surfaces inline. Pre-fix the operator saw
"Execution needs diagnosis · 1 warning" with no inline explanation and
had to drop out of chat to figure out what was warned about. Post-fix
the warning is part of the result line and the next decision is offered
in the same turn.

---

## Flow D — OAuth2 connector creation (unchanged contract)

OAuth2 is the only happy-path flow that still uses harness auto-persist
on form-submit, because `authenticate_oauth` needs a persisted
`connector_id` before it can mint tokens.

```
› you   set up a github oauth app for me

✓ Connector draft ready · github-oauth · http · dev · auth=oauth2
  Need: GitHub OAuth app client_id + client_secret
  (https://github.com/settings/developers → New OAuth App)

› you   client_id=abc, client_secret=***
        ↑ ask_user_form with commit_intent: save_connector

✓ Connector saved · github-oauth (audit reason: auto_persist_on_confirmation)
✓ Authorization URL opened — sign in at https://github.com/login/oauth/...
✓ Tokens received · github-oauth ready

✓ Endpoint check complete · GET /user · dev · HTTP 200 · 412ms
  (probe runs against the persisted connector — no second auto-save)

• sk    github-oauth is saved and authorised. Which workflow should it power?
```

Operator action count: **2** (client_id/secret form, then the OAuth
authorization in the browser).
Audit rows written, in order:
1. `connector.created` (reason: `auto_persist_on_confirmation`,
   commit_intent_kind: `save_connector`)
2. `oauth.callback` + `credential.created`
3. `conversation.probe_connector` (result: success — but no second save
   audit, the connector is already persisted and the probe's atomic
   helper short-circuits on `saved_connector_id`)

---

## Lifecycle vocabulary the assistant uses

The chat surface translates raw `lifecycle_state` tokens into operator
language. Snapshot for grep:

| `lifecycle_state` raw token | User-facing verb |
|---|---|
| `connector_targeted` | drafting |
| `connector_inspected` | inspected |
| `connector_validated` | ready |
| `connector_authenticated` | authenticated |
| `connector_probed` | probe ok |
| `connector_persisted` | saved |
| `workflow_targeted` | drafting |
| `workflow_validated` | ready |
| `workflow_previewed` | previewed |
| `workflow_persisted` | committed |
| `workflow_executed` | ran |

---

## Diagnostic signals (read in operator triage)

Each transition emits a structured log with `tenant_id` + `conversation_id`
correlation. Filter `~/.sk/debug.log` (sk-CLI) or
`/v1/diagnostics/logs/stream` (engine) by these `action`s when triaging:

| `action` | Surface | Level | When |
|---|---|---|---|
| `probe_connector_draft.auto_saved` | engine | info | Green probe persisted |
| `probe_connector_draft.auto_save_failed` | engine | warn | Atomic save refused (slug clash, etc.) |
| `dry_run_workflow.auto_committed` | engine | info | Clean preview persisted |
| `dry_run_workflow.auto_commit_failed` | engine | warn | Commit refused (gate, slug clash, etc.) |
| `dry_run_workflow.repair_loop_query_failed` | engine | warn | Repair-loop guard's history query failed |
| `truncate.applied` | engine | debug | Tool output exceeded MAX_JSON_CHARS |
| `loop.empty_text_synthesized` | engine | info\|warn | Model emitted no text; `synthesis_reason` distinguishes the case |
| `engine.topo_sort_fallback` | engine | error | Cycle slipped past pre-flight gate (contract violation) |
| `queue.handlers.registered` | engine | info | Boot summary; all worker IDs present |

A healthy session of any of the four flows above produces the matching
`auto_saved` / `auto_committed` info line, never an `auto_*_failed` warn.
A healthy run produces zero `engine.topo_sort_fallback` errors.

---

## Anti-patterns the engine no longer surfaces

These should never appear in a real chat session. If they do, the bug is
on the engine side:

- `Summary of the latest tool results: fields: mode, stage, lifecycle_state, ...`
  (was: lifecycle envelope leaking through fallback synthesis).
- `__omitted_chars: <n>`, `__raw_ref: raw_<id>` in any user-visible
  output (was: truncation envelope leaking past renderer).
- `approve · Save <name> connector` after a green probe (was: missing
  inline auto-save).
- `approve · Save the current workflow draft` after a clean dry-run
  (was: missing inline auto-commit).
- A model turn that ends silently after a successful tool call (was:
  no `next_prompt` synthesis path).

If you see one of these in a real transcript, capture the conversation
ID and `~/.sk/debug.log` slice and file an issue against
`apps/engine/src/conversations/`.
