---
slug: sk-ref-mcp-tools
name: sk Platform Reference — MCP Tool Catalog
description: The public MCP callable surface of sk — every tool name (underscore form), grouped by purpose, plus the confirm two-call flow, warnings envelope, OAuth scopes, and resource URI schemes.
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
Workflow slugs are kebab-case (`wf_corsica-ferries-prices`).

The catalog is shaped by the caller's MCP mode (OAuth scope) and trimmed to a
token budget. A small **core floor** is never trimmed: `find_workflow`,
`run_workflow`, `authenticate`, `confirm_tool_call`, `list_recipes`. The
per-workflow `wf_<slug>` palette rides alongside (Top-40). The long tail stays
reachable via `find_workflow` → `run_workflow(slug)` (search-first); nothing
becomes unreachable.

# Workflow Run & Inspect

Run saved workflows and read their executions.

- `wf_<slug>` — run the saved workflow by slug (one materialized tool per
  workflow; inputSchema is the workflow's declared input schema). Fast runs
  return inline; a slow run (>~50s) returns `{ status: "running", execution_id,
  poll_with: "get_execution" }`.
- `run_workflow` — generic run by `slug` (the search-first fallback when a
  `wf_<slug>` tool was trimmed from the palette).
- `find_workflow` — search the tenant's workflow library by intent.
- `list_workflows` — enumerate workflows.
- `get_workflow` — fetch a workflow's metadata.
- `inspect_workflow` — read the committed workflow definition (DAG, steps).
- `get_execution` — fetch one execution's status and output (poll handle for
  long runs).
- `list_executions` — list past executions.
- `inspect_execution` — full execution detail (steps, timings, errors).
- `inspect_execution_step` — drill into a single step's input/output.
- `rerun_execution` — re-run a prior execution (tenant_write).
- `get_raw_result` — fetch an offloaded/oversize result payload.
- `list_attachments` / `preview_attachment` — execution-produced files.
- `diagnose_latest_execution` — auto-diagnose the most recent failure.

Schedules: `list_schedules`, `create_schedule`, `update_schedule`,
`delete_schedule` (the create/update/delete are tenant_write).

## wf_<slug> run semantics

- Write-classified steps (sends, external writes) are **held** by default — they
  resolve but never dispatch — so verifying a workflow can't fire a real send.
  A live run is the explicit opt-in `_meta.execute_writes: true`.
- `_meta.environment` selects `"dev"` (default) or `"prod"`.
- `_meta.progressToken` enables `notifications/progress` frames per step.

# Authoring & Conversation

Authoring happens **only** through a guided conversation. There is no separate
build/draft/dry-run tool to call over MCP — the engine runs every authoring step
inside the conversation and surfaces results back to you.

- `conversation_start` — open a new authoring conversation (optional
  `connector_id` / `workflow_id`, plus `message`). Runs the first turn in the
  background; returns immediately with a task to poll. Also the entry point for
  OAuth connector authorization. (tenant_write)
- `conversation_append` — send the next user message into an open conversation.
  (tenant_write)
- `conversation_get` — fast read-only poll of conversation state, messages, and
  any pending elicitation. (tenant_read)
- `conversation_respond_elicitation` — answer an in-conversation elicitation
  (`elicitation_id`, `output`, optional `reason`). (tenant_write)
- `conversation_commit` — commit the authored workflow/connector to a live,
  versioned definition. (tenant_read gate; performs the commit)
- `suggest_related_conversations` — before starting fresh, check whether this
  prompt continues a prior conversation (ranked, caller's own only) so you can
  resume via `conversation_append`. Suggestion only.

Poll loop: `conversation_start`/`conversation_append` return a task →
poll `conversation_get` until the turn settles (answer or elicitation).

## Authoring-mode helper tools

In authoring/admin mode the fuller LLM authoring palette is also exposed
(used inside the conversation loop, callable directly when scoped): e.g.
`call_connector`, `discover_connector_endpoints`, `discover_systems_from_files`,
`analyze_scrape_target`, `match_connector_template_by_url`,
`suggest_connector_templates`, `dry_run_transform`, `dry_run_patch_candidate`,
`propose_schema_migration`, `test_rbac_expression`, `cannot_help`. Prefer the
`conversation_*` entry point; these are building blocks, not the front door.

# Connectors

Inspect connectors and their docs (credentials are never returned).

- `find_connector` — search connectors by name/intent.
- `list_connectors` — enumerate connectors.
- `get_connector` — connector metadata (no secrets).
- `fetch_connector_docs` — pull a connector's documentation/recipe text.
- `test_connector` / `probe_connector` — live reachability/auth probe.
- `suggest_connector_templates` / `match_connector_template_by_url` — find a
  template for a target system.
- `request_connector_reauth` — trigger a re-authorization prompt.
- `update_connector` / `delete_connector` — mutate (tenant_write).

OAuth: authorize a connector via `authenticate` (core floor) or by starting a
`conversation_start` flow.

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

- `search_knowledge` — semantic search over the tenant's Knowledge Sources.
- `search_knowledge_v2` — newer ranked knowledge search (chunk-level).
- `list_knowledge_sources` — enumerate Knowledge Sources.
- `get_knowledge_source` — one source's metadata + chunk count.
- `search_docs` — search the sk product documentation.
- `fetch_connector_docs` — connector-specific documentation/recipe.

Web-search escalation precedence: `search_knowledge` → `search_docs` →
`fetch_connector_docs` before any external web lookup.

Knowledge writes (authoring/admin): `create_knowledge_source`,
`update_knowledge_source`, `delete_knowledge_source`, `analyze_knowledge_source`.

# Identity & RBAC

Who am I, who can do what.

- `whoami` — the calling principal (id, tenant, scopes, roles).
- `find_user` / `get_user` / `list_users` — directory lookups.
- `list_system_accounts` — non-human principals.
- `find_role` / `get_role` / `inspect_role` / `list_roles` — role definitions.
- `edit_role` — mutate a role (tenant_write).
- `test_rbac_expression` — evaluate an RBAC expression against a context.
- API keys: `list_api_keys`, `get_api_key`, `create_api_key`, `revoke_api_key`.
- Portal tokens: `list_portal_tokens`, `revoke_portal_token`.

# Operator & Observability

Health, cost, and audit.

- `get_engine_status` — engine/version/health snapshot.
- `get_token_budget` — LLM token budget accounting.
- `get_llm_usage` — LLM usage/cost rollup.
- `list_audit` / `get_audit_entry` — the audit log (every governed action,
  incl. `APPROVAL_REQUESTED` / `APPROVAL_APPROVED`).
- Inbound hooks: `list_inbound_hooks`, `get_inbound_hook`.
- Subscriptions: `list_subscriptions`, `get_subscription`, `update_subscription`,
  `delete_subscription`.

# Self-Healing, Skills & Discovery

Proposed (not auto-applied) improvements.

- Patch candidates: `list_patch_candidates`, `get_patch_candidate`,
  `preview_patch_candidate`, `dry_run_patch_candidate`, `approve_patch_candidate`.
- Skills: `list_skills`, `list_all_skills`, `find_skill`, `get_skill`,
  `create_skill`, `update_skill`, `delete_skill`.
- Skill candidates / suggestions: `list_skill_candidates`, `get_skill_candidate`,
  `list_skill_suggestions`, `approve_skill_candidate`.
- Capability gaps: `list_capability_gaps`.
- Discovery: `list_discovery_artifacts`, `get_discovery_artifact`,
  `approve_discovery_artifact`.

# Destructive Two-Call Confirm Flow

Tenant-write / destructive tools are guarded by a confirm gate. The flow:

1. First call → the dispatcher's policy returns `{ status: "needs_confirm",
   confirm: { tool, reason, args, confirm_id } }` and writes an
   `APPROVAL_REQUESTED` audit row.
2. Second call → re-issue with `_meta.sk_confirm: true` and
   `_meta.sk_confirm_id: <confirm_id>`. A valid match writes `APPROVAL_APPROVED`
   (same resource id, joining the lifecycle) and executes.

Client paths:
- **Elicitation-capable clients** are prompted in-band via
  `elicitation/create` — the engine resolves the gate for you; no manual `_meta`.
- **Non-elicitation clients** call the `confirm_tool_call` tool
  (`tool`, `arguments`, `confirm_id`) to approve. This responder is in the core
  floor for those clients.

A confirm without a matching un-consumed `APPROVAL_REQUESTED` is rejected — you
cannot approve a call that was never gated.

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

- `mcp:read` — product mode (default when no `mcp:*` marker): saved `wf_<slug>`
  workflows, the core floor, and `authenticate`. Read + run only.
- `mcp:authoring` — authoring mode: adds the `conversation_*` authoring tools and
  tenant **read** tools (inspect/list/get). No tenant writes.
- `mcp:admin` — admin mode: adds tenant **write** tools (create/update/delete,
  approve, mutate) on top of authoring.

A read-only deployment (`mcp.read_only`) suppresses tenant writes even in admin
mode. Mode is resolved per session from the principal's scopes.

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
