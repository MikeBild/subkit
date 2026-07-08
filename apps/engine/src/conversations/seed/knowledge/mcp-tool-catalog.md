---
slug: sk-ref-mcp-tools
name: sk Platform Reference — MCP Tool Catalog
description: The public MCP callable surface of sk — every tool name (underscore form) tagged with the MCP mode that can call it, plus the write approval gate, warnings envelope, OAuth scopes, and resource URI schemes.
tags: [sk-platform-reference, mcp, tools, oauth, resources]
scope: global
version: 1
---

# MCP Tool Catalog — Overview

sk exposes its engine over the Model Context Protocol (MCP). A connected client
sees a `tools/list` catalog and calls tools via `tools/call`. Every run is
RBAC-checked, audited, and version-pinned.

Naming rule: **MCP tool names use underscores, never dots.** Correct: `wf_<slug>`,
`conversation_start`, `run_workflow`, `search_knowledge`. Any dotted form
(`wf.<slug>`, `conversation.*`) seen in older prose is wrong — use underscore.
Workflow slugs are kebab-case (`wf_daily-price-report`).

The catalog is shaped by the caller's MCP mode (OAuth scope) and trimmed to a
token budget. A small **core floor** is never trimmed: `find_workflow`,
`run_workflow`, `authenticate`, `confirm_tool_call`, `list_recipes`. The
per-workflow `wf_<slug>` palette rides alongside (Top-40). The long tail stays
reachable via `find_workflow` → `run_workflow(slug)` (search-first); nothing
becomes unreachable.

# Availability

Every tool below carries the **lowest MCP mode that can call it**:

- **[product]** — every client, including the default `mcp:read` principal.
- **[authoring]** — `mcp:authoring` and above.
- **[admin]** — `mcp:admin` only, and suppressed entirely when the deployment
  sets `mcp.read_only`.

The tag is about *callability*, which is the only thing that matters to you.
`tools/list` is a shorter list than this catalog: it is fitted to a token budget,
so an authoring/admin client can call tools it never sees listed — name them from
here. The reverse never happens. A tool tagged above your mode is rejected, and
so is any tool you invent.

**Draft tools are rejected on MCP in every mode.** They mutate a conversation's
working draft, and a stateless `tools/call` has no draft to mutate:
`author_workflow`, `save_workflow_draft`, `edit_workflow_patch`, `validate_draft`,
`dry_run_workflow`, `dry_run_step`, `restore_draft_snapshot`,
`diagnose_latest_execution`, `request_connector_reauth`, `propose_skill`,
`ask_user_*`, and every `*_connector_draft` tool. The engine runs them for you
inside a `conversation_*` session — that is the only place they exist.

# Workflow Run & Inspect

Run saved workflows and read their executions.

- `wf_<slug>` **[product]** — run the saved workflow by slug (one materialized
  tool per workflow; inputSchema is the workflow's declared input schema). Fast
  runs return inline; a slow run (>~50s) returns `{ status: "running",
  execution_id, poll_with: "get_execution" }`.
- `run_workflow` **[product]** — generic run by `slug` (the search-first fallback
  when a `wf_<slug>` tool was trimmed from the palette).
- `find_workflow` **[product]** — search the tenant's workflow library by intent.
- `get_execution` **[product]** — fetch one execution's status and output; this
  is what resolves the poll handle a long run hands back.
- `list_recipes` **[product]** / `inspect_recipe` **[product]** — browse and read
  the workflow recipe catalog.
- `get_workflow` **[authoring]** — fetch a saved workflow's metadata by id.
- `list_workflows` **[authoring]** — enumerate workflows. Prefer `find_workflow`.
- `inspect_execution` **[authoring]** — full execution detail (steps, timings,
  errors). This is how you diagnose a failed run over MCP.
- `inspect_execution_step` **[authoring]** — drill into a single step's
  input/output.
- `list_executions` **[authoring]** — list past executions.
- `get_raw_result` **[authoring]** — fetch an offloaded/oversize result payload.
- `list_attachments` / `preview_attachment` **[authoring]** — execution-produced
  files.
- `list_schedules` **[authoring]**; `create_schedule`, `update_schedule`,
  `delete_schedule` **[admin]**.
- `rerun_execution` **[admin]** — re-run a prior execution.

`inspect_workflow` **[authoring]** reads the conversation DRAFT, not a saved
workflow; over MCP that draft is always empty. Use `get_workflow` for a saved
definition and `inspect_execution` for what a run actually did.

## wf_<slug> run semantics

- Write-classified steps (sends, external writes) are **held** on every first
  call — they resolve but never dispatch — so verifying a workflow can't fire a
  real send. The result comes back `preview: true`, `writes_held: true`, and a
  `would_write` / `held_steps` list of exactly what a release would do. Nothing
  was written.
- **Releasing those writes is a person's decision, and you cannot make it.** The
  preview carries `awaiting_human_approval: true`, an `approval_url`, a
  `confirm_id`, and a `confirm_reason`. Send the `approval_url` to the person who
  must approve; they open it, read the `would_write` list, and approve or decline.
  It is `null` only when the deployment has no `server.public_base_url`, and then
  the writes cannot be approved at all — say so instead of re-running the tool.
- Once they have approved, `confirm_tool_call({ tool: "wf_<slug>", confirm_id })`
  performs the held writes. It approves nothing — before they decide it answers
  `approval_not_granted`. Never call it on your own initiative, and never in the
  same turn as the preview.
- `confirm_reason` says why no decision is in hand yet: `client_cannot_prompt`
  (your client never advertised `elicitation`) or `in_band_prompt_unfulfilled`
  (it advertised the capability and did not answer the prompt). Neither means
  nobody was asked. The link is the channel that works either way.
- **If your client answers in-band elicitation**, the engine asks the operator
  inside the call instead. An accept releases the writes in the same call and you
  never see a `confirm_id`. A decline comes back `operator_declined: true` with
  no `confirm_id` and no `approval_url` — terminal, nothing left to grant.
- The engine replays the inputs it already holds. There is no `execute_writes`
  parameter on this surface, and re-running the tool only reproduces the preview.
- `_meta.environment` selects `"dev"` (default) or `"prod"`.
- `_meta.progressToken` enables `notifications/progress` frames per step.

# Authoring & Conversation

Authoring happens **only** through a guided conversation. There is no separate
build/draft/dry-run tool to call over MCP — the engine runs every authoring step
inside the conversation and surfaces results back to you.

- `conversation_start` **[authoring]** — open a new authoring conversation
  (optional `connector_id` / `workflow_id`, plus `message`). Runs the first turn
  in the background; returns immediately with a task to poll. Also the entry
  point for OAuth connector authorization.
- `conversation_append` **[authoring]** — send the next user message into an open
  conversation.
- `conversation_get` **[authoring]** — fast read-only poll of conversation state,
  messages, and any pending elicitation.
- `conversation_respond_elicitation` **[authoring]** — answer an in-conversation
  elicitation (`elicitation_id`, `output`, optional `reason`).
- `conversation_commit` **[authoring]** — report the persisted commit state of the
  conversation's workflow (version written, steps present, read from the
  persisted rows). Read-only: it never persists; a draft with unpersisted
  edits returns a NOT COMMITTED error.
- `suggest_related_conversations` **[authoring]** — before starting fresh, check
  whether this prompt continues a prior conversation (ranked, caller's own only)
  so you can resume via `conversation_append`. Suggestion only.

Poll loop: `conversation_start`/`conversation_append` return a task →
poll `conversation_get` until the turn settles (answer or elicitation).

## Authoring-mode helper tools

Authoring mode can also call the engine's own authoring building blocks, even
though the token budget usually keeps them out of `tools/list`: `call_connector`,
`probe_connector`, `discover_connector_endpoints`, `discover_systems_from_files`,
`analyze_scrape_target`, `suggest_connector_templates`, `dry_run_transform`,
`dry_run_patch_candidate`, `suggest_jsonata_paths`, `propose_schema_migration`,
`test_rbac_expression`, `inspect_authoring_context`, `cannot_help` — all
**[authoring]**. Prefer the `conversation_*` entry point; these are building
blocks, not the front door.

# Connectors

Inspect connectors and their docs (credentials are never returned).

- `test_connector` **[product]** — live reachability/auth probe of a saved
  connector.
- `match_connector_template_by_url` **[product]** — find the template for a target
  system's base URL.
- `find_connector` **[authoring]** — search connectors by name/intent.
- `list_connectors` **[authoring]** — enumerate connectors.
- `get_connector` **[authoring]** — connector metadata, incl. re-auth health
  (never secrets).
- `fetch_connector_docs` **[authoring]** — pull a connector's documentation/recipe
  text.
- `fetch_connector_self_description` **[authoring]** — pull the target system's own
  machine-readable description.
- `probe_connector` **[authoring]** — live reachability/auth probe.
- `suggest_connector_templates` **[authoring]** — rank templates for a system.
- `update_connector`, `delete_connector`, `import_connector_from_spec`,
  `authenticate_oauth` **[admin]** — mutate.

OAuth: authorize a connector via `authenticate` **[product]** or by starting a
`conversation_start` flow. A connector whose credential expired is re-authorized
the same way — `request_connector_reauth` is a draft tool and is not callable
here.

Discovery grounding: `discover_connector_endpoints` probes a target system for a
machine-readable description and persists it for authoring. It tries, in order,
OpenAPI specs, GraphQL introspection, then **llms-txt** — the standard
`/llms-full.txt` or `/llms.txt` file (at the site root, or mirrored under
`/.well-known/`, per https://llmstxt.org), full-content variant first. llms-txt
carries the intent and pitfalls a bare schema omits (which auth header, error-code
meanings, gotchas), so a connector that publishes it lets authoring get the
conventions right on the first pass. `fetch_connector_docs` / `search_docs` then
search that grounded prose. The sk engine itself publishes `/llms.txt` and
`/llms-full.txt`, so it is discoverable the same way.

# Knowledge & Docs Search

Ground answers in tenant knowledge and product docs.

- `search_knowledge` **[authoring]** — semantic search over the tenant's Knowledge
  Sources.
- `search_knowledge_v2` **[authoring]** — newer ranked knowledge search
  (chunk-level).
- `list_knowledge_sources` **[authoring]** — enumerate Knowledge Sources.
- `get_knowledge_source` **[authoring]** — one source's metadata + chunk count.
- `search_docs` **[authoring]** — search the sk product documentation.
- `fetch_connector_docs` **[authoring]** — connector-specific documentation/recipe.

Web-search escalation precedence: `search_knowledge` → `search_docs` →
`fetch_connector_docs` before any external web lookup.

Knowledge writes **[admin]**: `create_knowledge_source`,
`update_knowledge_source`, `delete_knowledge_source`, `analyze_knowledge_source`.

# Identity & RBAC

Who am I, who can do what.

- `whoami` **[authoring]** — the calling principal (id, tenant, scopes, roles).
- `find_user` / `get_user` / `list_users` **[authoring]** — directory lookups.
- `list_system_accounts` **[authoring]** — non-human principals.
- `find_role` / `get_role` / `inspect_role` / `list_roles` **[authoring]** — role
  definitions.
- `test_rbac_expression` **[authoring]** — evaluate an RBAC expression against a
  context.
- API keys: `list_api_keys`, `get_api_key` **[authoring]**; `create_api_key`,
  `revoke_api_key` **[admin]**.
- Portal tokens: `list_portal_tokens` **[authoring]**; `revoke_portal_token`
  **[admin]**.
- `edit_role` **[admin]** — mutate a role.

# Operator & Observability

Health, cost, and audit.

- `get_engine_status` **[authoring]** — engine/version/health snapshot.
- `get_token_budget` **[authoring]** — LLM token budget accounting.
- `get_llm_usage` **[authoring]** — LLM usage/cost rollup.
- `list_audit` / `get_audit_entry` **[authoring]** — the audit log (every governed
  action; approval lifecycle rows read `approval.requested`, `approval.granted`,
  `approval.declined`, `approval.approved`).
- Inbound hooks: `list_inbound_hooks`, `get_inbound_hook` **[authoring]**.
- Subscriptions: `list_subscriptions`, `get_subscription` **[authoring]**;
  `update_subscription`, `delete_subscription` **[admin]**.

# Self-Healing, Skills & Discovery

Proposed (not auto-applied) improvements.

- Patch candidates: `list_patch_candidates`, `get_patch_candidate`,
  `preview_patch_candidate`, `dry_run_patch_candidate` **[authoring]**;
  `approve_patch_candidate` **[admin]**.
- Skills: `list_skills`, `list_all_skills`, `find_skill`, `get_skill`
  **[authoring]**; `create_skill`, `update_skill`, `delete_skill` **[admin]**.
- Skill candidates / suggestions: `list_skill_candidates`, `get_skill_candidate`,
  `list_skill_suggestions` **[authoring]**; `approve_skill_candidate` **[admin]**.
- Capability gaps: `list_capability_gaps` **[authoring]**.
- Discovery: `list_discovery_artifacts`, `get_discovery_artifact` **[authoring]**;
  `approve_discovery_artifact` **[admin]**.

Approval is always an operator's act. These tools relay a decision the user gave
you explicitly; you never take one on your own initiative.

# Write Approval Gate

Tenant-write / destructive tools are guarded by a confirm gate. The gate always
runs the same lifecycle: the call pauses, an `approval.requested` audit row is
written with the exact args (encrypted), a HUMAN decides — `approval.granted` or
`approval.declined` — and the tool executes only after an `approval.approved` row
joins the same approval id. The engine replays the args it persisted; you never
re-send them.

The approval is a human's, and you cannot make it. `confirm_tool_call` does not
approve — it TRIGGERS a call a person already granted. Until they have, it
answers `approval_not_granted`. The same is true of a `_meta.sk_confirm` marker.
Neither needs to be refused, because neither opens by itself.

One rule, every write tool — including `run_workflow` and `wf_<slug>`:

- The paused call comes back `status: "needs_confirm"`. Its fields are exactly:
  `tool`, `pending_output` (a structured preview of what the call will do, never
  the payload), `policy_mode`, `reason`, `tool_call_id`, `approval_url`, and
  `resume`. There is **no `args` field** and no `confirm_id` field — the handle is
  named `tool_call_id`.
- `approval_url` is where a person grants or declines. Send that link to whoever
  must approve; they open it, read exactly what will be written, and decide. It is
  `null` only when the deployment has no `server.public_base_url`, and then the
  call cannot be approved at all — say so instead of retrying.
- Once they approve, fire `confirm_tool_call({ tool, confirm_id })`, passing the
  envelope's `tool_call_id` as `confirm_id`. The engine replays the args it
  persisted and executes.
- **If your client answers `elicitation`**, the engine may first show the operator
  the same confirmation inside the call, as an optimization over that round-trip.
  An accept executes immediately (you never see the envelope at all); a decline is
  terminal (`confirm_declined`, and the approval is dead). If your client
  advertises the capability and does not answer the prompt, you get the ordinary
  `needs_confirm` envelope with its `approval_url` — the engine has no decision
  from anyone. Do not report that as a refusal, and do not claim nobody was asked.

A confirm without a matching, GRANTED, un-consumed approval is rejected — you
cannot approve a call that was never gated, you cannot approve one yourself, and
a handle is single-use.

# Warnings Envelope

When a run completes with non-fatal warnings (e.g. an unresolved interpolation
identifier), the result is wrapped:

```
{ "output": <payload-or-null>, "warnings": [ ... ] }
```

A clean run returns the raw payload unwrapped. Oversize results (>20 KB inline
cap) are offloaded and returned as an MCP `resource_link` (`fixture://<id>`) with
a text summary; warnings travel in the summary.

# OAuth Scopes & MCP Modes

The catalog and write visibility are gated by the principal's `mcp:*` scope.
These scope markers select the MCP **mode**; they do NOT widen resource
permissions — RBAC still bounds every action.

- `mcp:read` — product mode (default when no `mcp:*` marker). The whole surface
  is: the `wf_<slug>` palette, the core floor (`find_workflow`, `run_workflow`,
  `authenticate`, `confirm_tool_call`, `list_recipes`), plus `get_execution`,
  `inspect_recipe`, `test_connector`, `match_connector_template_by_url`. Read +
  run only; anything else is rejected.
- `mcp:authoring` — authoring mode: adds the `conversation_*` session tools and
  every tenant **read** tool (find/list/get/inspect/search/probe/dry-run). No
  tenant writes — `run_workflow` and `wf_<slug>` stay available because a
  workflow run is a run, not a config mutation.
- `mcp:admin` — admin mode: adds the tenant **write** tools (create/update/delete,
  approve, mutate) on top of authoring.

A read-only deployment (`mcp.read_only`) suppresses tenant writes even in admin
mode; workflow runs remain. Mode is resolved per session from the principal's
scopes, and RBAC gates every call on top of it — a mode never widens a
permission the principal does not hold.

# Resource URI Schemes

MCP resources expose tenant state for `resources/read` and live
`resources/subscribe` updates. Schemes:

- `workflow://<id>` — committed workflow definition.
- `connector://<id>` — connector metadata (never credentials).
- `knowledge://<id>` — Knowledge Source metadata + chunk count.
- `skill-candidate://<id>` — a proposed skill improvement.
- `fixture://<id>` — an offloaded/oversize execution payload (read-only).
- `file://<id>` — an execution-produced attachment.

Subscribable (emit `notifications/resources/updated`): `workflow://`,
`connector://`, `knowledge://`, `skill-candidate://`. The notification carries no
payload — re-read the URI for the new state. `tools/list_changed` fires when the
`wf_<slug>` catalog changes (workflow create/update/delete/restore).
