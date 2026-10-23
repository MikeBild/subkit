---
slug: sk-ref-mcp-tools
name: sk Platform Reference — MCP Tool Catalog
description: The public MCP callable surface of sk — every tool name (underscore form) tagged with the MCP mode that can call it, plus the write approval gate, warnings envelope, OAuth scopes, resource URI schemes, and how a remote MCP server the tenant registered (a connector with driver `mcp`) relates to this catalog.
tags: [sk-platform-reference, mcp, tools, oauth, resources]
scope: global
version: 6
---

# MCP Tool Catalog — Overview

## Collected material review

`list_intake_categories` discovers shared intake categories.
Review individual clips through a persisted `conversation_start` conversation;
pass `intake_item_ids` to fix the selection. Continue with `conversation_get`
and `conversation_append`. The returned review URL opens that conversation in
the authenticated Cockpit. `list_intake_items`, `get_intake_item`,
`discard_intake_items`, `restore_intake_item`, `move_intake_item`,
`set_default_intake_category`, `create_intake_proposal`, and
`revise_intake_proposal` require the saved review
context and are not executable as standalone MCP calls. There is no MCP tool
that confirms intake admission. A person reviews the exact content, sources
and destination in the Cockpit before confirming. Raw clips never become
ordinary knowledge merely because they were collected or read.

sk exposes its engine over the Model Context Protocol (MCP). A connected client
sees a `tools/list` catalog and calls tools via `tools/call`. Every run is
RBAC-checked, audited, and version-pinned.

Naming rule: **MCP tool names use underscores, never dots.** Correct: `wf_<slug>`,
`conversation_start`, `run_workflow`, `search_knowledge`. Any dotted form
(`wf.<slug>`, `conversation.*`) seen in older prose is wrong — use underscore.
Workflow slugs are kebab-case (`wf_daily-price-report`).

The catalog is shaped by the caller's MCP mode (OAuth scope). The FULL catalog
for the mode is advertised — `tools/list` publishes every tool the mode exposes,
with no server-side trim. A small **core floor** is always present:
`find_workflow`, `run_workflow`, `authenticate`, `list_recipes`.
The per-workflow `wf_<slug>` palette rides alongside (Top-40);
workflows past the cap stay reachable via `find_workflow` → `run_workflow(slug)`.

When a client caps how many tools it preloads, its OWN native tool-search /
defer-loading fetches any remaining tool on demand — there is no discovery
meta-tool. For workflows use `find_workflow`; for connectors use `find_connector`
(these search tenant DATA, not the tool catalog).

**claude.ai CACHES `tools/list`.** After an engine upgrade that changes the
catalog, claude.ai keeps serving the stale cached tool list — new tools do NOT
appear until the user **removes and re-adds the connector** (GitHub
claude-ai-mcp #137). If a documented tool is missing after an upgrade, that stale
cache is the cause.

# Availability

Every tool below carries the **lowest MCP mode that can call it**:

- **[product]** — read and execute. The default for every credential without an
  explicit `mcp:*` marker, including a plain wildcard `*`. Reads the tenant and
  runs what is already there.
- **[authoring]** — `mcp:authoring` and above. Adds the tools that BUILD
  definitions: the `conversation_*` cluster and the authoring helpers.
- **[admin]** — `mcp:admin` only, and suppressed entirely when the deployment
  sets `mcp.read_only`.

The tag is about _callability_, which is the only thing that matters to you.
`tools/list` advertises the full catalog for your mode; if your client preloads
only part of it, its native tool-search fetches the rest on demand, and you can
always name a tool from here directly. The reverse never happens. A tool tagged
above your mode is rejected, and so is any tool you invent.

**Draft tools are rejected on MCP in every mode.** They mutate a conversation's
working draft, and a stateless `tools/call` has no draft to mutate:
`author_workflow`, `save_workflow_draft`, `edit_workflow_patch`, `validate_draft`,
`dry_run_workflow`, `dry_run_step`, `restore_draft_snapshot`,
`diagnose_latest_execution`, `request_connector_reauth`,
`ask_user_*`, `switch_authoring_focus`, and every `*_connector_draft` tool. The
engine runs them for you inside a `conversation_*` session — that is the only
place they exist. Inside a session, `switch_authoring_focus` moves between
connector and workflow authoring without losing the workflow draft.

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
- `get_workflow` **[product]** — fetch a saved workflow's metadata by id. With
  `include_draft: true` it also returns the saved inactive draft (`version_id`,
  `version`, `digest`, full `definition`); a session can pass that `version_id`
  to `save_workflow_draft` as `expected_draft_version_id`, and a stale id is
  refused with `draft_conflict` instead of overwriting newer work.
- `list_workflows` **[product]** — enumerate workflows. Prefer `find_workflow`.
- `inspect_execution` **[product]** — full execution detail (steps, timings,
  errors). This is how you diagnose a failed run over MCP.
- `inspect_execution_step` **[product]** — drill into a single step's
  input/output.
- `list_executions` **[product]** — list past executions.
- `get_raw_result` **[product]** — fetch an offloaded result. Small results return whole; large results list fields to fetch by path and bounded chunks via offset/limit.
- `list_attachments` / `preview_attachment` **[product]** — execution-produced
  files.
- `list_schedules` **[product]**; `create_schedule`, `update_schedule`,
  `delete_schedule` **[admin]**.
- `rerun_execution` **[admin]** — re-run a prior execution.

`inspect_workflow` **[product]** reads the conversation DRAFT, not a saved
workflow; over MCP that draft is always empty. Use `get_workflow` for a saved
definition and `inspect_execution` for what a run actually did.

## wf_<slug> run semantics

- Write-classified steps (sends, external writes) are **held** on every first
  call — they resolve but never dispatch — so verifying a workflow can't fire a
  real send. The result comes back `preview: true`, `writes_held: true`, and a
  `would_write` / `held_steps` list of exactly what a release would do. Nothing
  was written.
- **Releasing those writes is a person's decision, and you cannot make it.**
  Report the `would_write` list to the operator and stop there. There is no
  `approval_url`, no `confirm_id` and no `confirm_tool_call` on this surface —
  those were removed; do not tell the operator to expect a link.
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

Authoring mode adds the engine's own building blocks for composing a definition
— all **[authoring]**: `discover_connector_endpoints`,
`discover_systems_from_files`, `analyze_scrape_target`,
`suggest_connector_templates`, `match_connector_template_by_url`,
`dry_run_transform`, `suggest_jsonata_paths`, `propose_schema_migration`,
`test_rbac_expression`, `inspect_authoring_context`, `fetch_connector_docs`,
`fetch_connector_self_description`. Prefer the `conversation_*` entry point;
these are building blocks, not the front door.

`call_connector` and `probe_connector` are **[product]**, not authoring helpers:
calling and testing a connector that already exists is execution, and that is
what the read-and-execute tier is for.

# Connectors

Inspect connectors and their docs (credentials are never returned).

- `test_connector` **[product]** — live reachability/auth probe of a saved
  connector.
- `match_connector_template_by_url` **[product]** — find the template for a target
  system's base URL.
- `find_connector` **[product]** — search connectors by name/intent.
- `list_connectors` **[product]** — enumerate connectors.
- `get_connector` **[product]** — connector metadata, incl. re-auth health
  (never secrets).
- `fetch_connector_docs` **[authoring]** — pull a connector's documentation/recipe
  text.
- `fetch_connector_self_description` **[authoring]** — pull the target system's own
  machine-readable description.
- `probe_connector` **[product]** — one-shot HTTP request the caller shapes
  (method + path + headers), for sniffing a response before writing a step. It
  always speaks HTTP, so it is not the right probe for a non-HTTP driver.
- `suggest_connector_templates` **[authoring]** — rank templates for a system.
- `update_connector`, `delete_connector`, `import_connector_from_spec`,
  `authenticate_oauth` **[admin]** — mutate.

## External MCP servers are connectors

A remote MCP server the tenant talks to is a **connector with `driver: "mcp"`**
— five drivers exist: `http`, `graphql`, `postgres`, `s3`, `mcp`. Its endpoint
is `base_url`; its transport and non-secret auth shape live under
`config.mcp` (`transport`, `auth.kind`, an optional
`remote_tool_call_timeout_ms`); its secret is an ordinary credential row keyed
on `(tenant, connector, environment)`. It is created, listed, patched, enabled,
disabled and deleted with the connector tools above and the connector REST
routes — there is no separate MCP-server registry, no `mcp-servers` tool
family, and no `mcp_server:manage` permission. A caller asking to "add an MCP
server" is asking for a connector.

`test_connector` **[product]** is what checks one: for an `mcp` connector it
forces a real handshake and reports the tool count.

Its OAuth is NOT the `authenticate` tool below. `authenticate` builds an
authorization URL from the connector's declared OAuth config, which an MCP
connector does not have — an MCP server publishes its own authorization server,
so the grant runs through `POST /v1/connectors/{id}/mcp/authorize` (or
`sk connectors mcp-authorize`), an operator action outside this catalog. Say
that rather than handing over a link the token endpoint will reject.

**The remote's own tools are not in this catalog.** They are minted into the
CHAT palette as `mcp_<connector_slug>__<remote_tool>` — plus read-only
`list_resources` / `list_resource_templates` / `read_resource` / `list_prompts` / `get_prompt` adapters
where the server declared those capabilities — and a workflow reaches them
through a `request` step carrying an `mcp` block. Over MCP you can see such a
connector and prove it handshakes; you cannot call its remote tools from here.
Never advertise an `mcp_…` name to a caller on this surface.

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

- `search_knowledge` **[product]** — semantic search over the tenant's Knowledge
  Sources.
- `list_knowledge_sources` **[product]** — enumerate Knowledge Sources.
- `get_knowledge_source` **[product]** — one source's metadata + chunk count.
- `search_docs` **[product]** — search the sk product documentation.
- `fetch_connector_docs` **[authoring]** — connector-specific documentation/recipe.

Web-search escalation precedence: `search_knowledge` → `search_docs` →
`fetch_connector_docs` before any external web lookup.

Knowledge writes **[admin]**: `create_knowledge_source`,
`update_knowledge_source`, `delete_knowledge_source`, `analyze_knowledge_source`.

# Identity & RBAC

Who am I, who can do what.

- `whoami` **[product]** — the calling principal (id, tenant, scopes, roles).
- `find_user` / `get_user` / `list_users` **[product]** — directory lookups.
- `list_system_accounts` **[product]** — non-human principals.
- `find_role` / `get_role` / `inspect_role` / `list_roles` **[product]** — role
  definitions.
- `test_rbac_expression` **[authoring]** — evaluate an RBAC expression against a
  context.
- API keys: `list_api_keys`, `get_api_key` **[product]**; `create_api_key`,
  `revoke_api_key` **[admin]**.
- Portal tokens: `list_portal_tokens` **[product]**; `revoke_portal_token`
  **[admin]**.
- `edit_role` **[admin]** — mutate a role.

# Operator & Observability

Health, cost, and audit.

- `get_engine_status` **[product]** — engine/version/health snapshot.
- `get_token_budget` **[product]** — LLM token budget accounting.
- `get_llm_usage` **[product]** — LLM usage rollup with the priced spend of a
  window (catalog or override price per model, unpriced models named).
- `get_operating_figures` **[product]** — the Übersicht's operations figures
  over a window: runs, success rate, healthy connectors, applied repairs.
- `list_connections` **[product]** — outbound connections: state, whether the
  grant renews itself (`auto_renew`), and the connectors using it.
- `list_audit` / `get_audit_entry` **[product]** — the audit log (every governed
  action; approval lifecycle rows read `approval.requested`, `approval.granted`,
  `approval.declined`, `approval.approved`).
- Inbound hooks: `list_inbound_hooks`, `get_inbound_hook` **[product]**.
- Subscriptions: `list_subscriptions`, `get_subscription` **[product]**;
  `update_subscription`, `delete_subscription` **[admin]**.

# Self-Healing, Skills & Discovery

Proposed (not auto-applied) improvements.

- Patch candidates: `list_patch_candidates`, `get_patch_candidate`,
  `preview_patch_candidate`, `dry_run_patch_candidate` **[product]**;
  `approve_patch_candidate` **[admin]**.
- Skills: `list_skills`, `list_all_skills`, `find_skill`, `get_skill`
  **[authoring]**; `update_skill`, `delete_skill` **[admin]**. A new skill comes
  from a confirmed intake proposal with a skill destination, never from a chat
  tool call.
- Skill candidates / suggestions (patterns the engine detected): `list_skill_candidates`, `get_skill_candidate`,
  `list_skill_suggestions`, `approve_skill_candidate`, `reject_skill_candidate`
  (batch of 1-100 ids) **[authoring]** — `list_skill_candidates` pages with
  `limit`/`offset` and reports `total`; approval and rejection are
  directly callable; the client's native destructive-write dialog is the explicit operator approval and
  RBAC `skill:write` stays the hard gate.
- Gate repairs: `diagnose_workflow` **[product]** — why the approval gate holds a
  workflow (`{ workflow_id, environment? }`): each refused step with its gate
  code, the report gate's reason when it named one (e.g. `not_utf8`), a
  `remedy_kind` (`patch`, `prepare`, `declare`, `reconnect`, `author`), a `fixer`
  when a deterministic repair exists, and `candidate_id` when it already waits for
  review. `propose_workflow_repair` **[product]** (`{ workflow_id, step_id, fixer,
  environment? }`) files that repair as a PROPOSED patch candidate — the engine
  computes the change, nothing applies until an operator approves it, and a
  repeat call returns the same candidate. Only the active version is repaired:
  a diagnosis with `is_current: false` is of the draft, whose fix is made in
  the draft.
- Capability gaps: `list_capability_gaps` **[product]** (each gap has a state: open,
  accepted, declined or resolved); `resolve_capability_gap` **[admin]** marks an
  open or accepted gap resolved with a short note.
- Session learnings: `save_learning` **[product]** — collect a durable practice
  or fact the user taught in the current session as an Intake item with origin
  `session` (`{ kind?, title, body, domains?, pitfalls? }`; the item lands in the
  shared category of the first existing domain). Additive and confirmation-free:
  it is not knowledge and not a skill until a person confirms a proposal in the
  Cockpit. Saving the same title in the same category again adds evidence to the
  existing item instead of duplicating it.
- Discovery: `list_discovery_artifacts`, `get_discovery_artifact` **[product]**;
  `approve_discovery_artifact` **[admin]**.

Approval is always an operator's act. These tools relay a decision the user gave
you explicitly; you never take one on your own initiative.

# Write Approval Gate

The approval for a write happens in YOUR client, before the call reaches sk.

Every write/destructive entry advertises `destructiveHint: true` in its
`tools/list` annotations; a trusted MCP client renders its own per-call
approval dialog from that hint. If the human allows, the call reaches sk and
executes directly, writing its audit row. If they deny, it never arrives.

There is no sk-side approval portal, no `approval_url`, no `confirm_tool_call`
and no `needs_confirm` envelope — those were removed. Do not author your own
confirmation prompt before a write either; your client already renders one, and
pre-empting it just asks the human twice.

The full contract lives in the `mcp-tool-contract` skill.

# Warnings Envelope

When a run completes with non-fatal warnings (e.g. an unresolved interpolation
identifier), the result is wrapped:

```
{ "output": <payload-or-null>, "warnings": [ ... ] }
```

A clean run returns the raw payload unwrapped. Oversize results (>20 KB inline
cap) are offloaded to the configured S3-compatible object store and returned as
an MCP `resource_link` with a text summary; warnings travel in the summary.

# OAuth Scopes & MCP Modes

The catalog and write visibility are gated by the principal's `mcp:*` scope.
These scope markers select the MCP **mode**; they do NOT widen resource
permissions — RBAC still bounds every action.

- `mcp:read`, a narrowed scope set, or a plain wildcard `*` — **read and
  execute**, the default. Every tenant read tool (`list_*`, `get_*`, `find_*`,
  `inspect_*`, `search_*`), plus `run_workflow`, `get_execution`, the
  `wf_<slug>` palette, `call_connector` and `probe_connector`. Read the tenant,
  run what is already there.
- `mcp:authoring` — adds the tools that BUILD definitions: the `conversation_*`
  session tools and the authoring helpers (`discover_connector_endpoints`,
  `dry_run_transform`, `suggest_*`, `propose_schema_migration`,
  `inspect_authoring_context`, …). Still no tenant writes.
- `mcp:admin` — adds the tenant **write** tools (create/update/delete, approve,
  mutate) on top of authoring.

**Authoring is opt-in, and a broad credential is not an opt-in.** A wildcard `*`
means "no narrowing of role-derived access"; it does not mean consent to author.
A credential authors over MCP only when someone wrote `mcp:authoring` on it.
Calling a `conversation_*` tool without that scope is refused, not merely hidden.

Where authoring normally happens is the `sk` CLI — `sk workflows create --file`,
`sk connectors create --file`, `sk connectors import --spec` — because a
definition edit should arrive as a file a person can read before it lands. If a
caller asks you to create or change a workflow, connector, knowledge source or
skill and you do not see the authoring tools, point at the CLI. Do not describe
a tool that is not in your catalog.

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
- `fixture://<id>` — a historical offloaded execution payload (read-only;
  new offloads use immutable S3 objects).
- `file://<id>` — an execution-produced attachment.

Subscribable (emit `notifications/resources/updated`): `workflow://`,
`connector://`, `knowledge://`, `skill-candidate://`. The notification carries no
payload — re-read the URI for the new state. `tools/list_changed` fires when the
`wf_<slug>` catalog changes (workflow create/update/delete/restore).
