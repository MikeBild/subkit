---
slug: mcp-tool-contract
scope: global
title: MCP Callable Contract
description: Reference for subkit's MCP callable surface — callable names, local human approvals and single-use replay, version-bound workflow authorities, synthesized input schemas, warnings, and remote MCP connectors. Consult this before driving subkit from any MCP client.
activates_when: [{"kind":"baseline"},{"kind":"intent_keyword","word":"mcp tool"},{"kind":"intent_keyword","word":"mcp tools"},{"kind":"intent_keyword","word":"tenant delete"},{"kind":"intent_keyword","word":"confirm_required"},{"kind":"intent_keyword","word":"sk_confirm"},{"kind":"intent_keyword","word":"ask_user_confirm"},{"kind":"intent_keyword","word":"unresolved_identifier"},{"kind":"intent_keyword","word":"warnings"},{"kind":"intent_keyword","word":"input schema"},{"kind":"intent_keyword","word":"wf_"},{"kind":"intent_keyword","word":"tenant_"},{"kind":"intent_keyword","word":"conversation_"}]
side_effects: read
idempotency: none
maturity: stable
tags: [mcp, contract]
version: 9
---

# subkit MCP callable contract

subkit exposes three families of callable entries over MCP. Calling them correctly saves round-trips and avoids duplicate confirmations.

## Callable families

- **Bare snake_case names** — the operator surface. Reads (`list_workflows`, `get_connector`, …) and writes (`delete_workflow`, `revoke_api_key`, …). Use these for CRUD. Names never carry a `tenant_` prefix and never contain dots.
- **`wf_<slug>`** — run a specific workflow. Arguments match the workflow's declared `input_schema`; when absent, subkit synthesises one from the DAG's `${input.X}` placeholders and jsonata `$input.X` references.
- **`conversation_*`** — multi-turn authoring sessions (`conversation_start`, `conversation_append`, `conversation_respond_elicitation`). Use these when the operator is **designing** a workflow or connector. Do NOT start a conversation for routine CRUD — the bare CRUD names are the cheap path.

There is no fourth family. In particular, the tools of a remote MCP server the tenant registered are **not** on this surface — see below.

The FULL authoring catalog is advertised — `tools/list` publishes every tool the mode exposes, with no server-side trim. When a client caps how many tools it preloads, its OWN native tool-search / defer-loading fetches any remaining tool on demand; you do not need a discovery meta-tool. For workflows use `find_workflow`; for connectors use `find_connector` (these search tenant DATA, not the tool catalog).

**claude.ai CACHES `tools/list`.** After an engine upgrade that changes the catalog, claude.ai keeps serving the old cached tool list — new tools will NOT appear until the user **removes and re-adds the connector** (GitHub claude-ai-mcp #137). If a documented tool is missing after an upgrade, that stale cache is the cause; tell the user to remove + re-add the connector.

## Reading `_meta.subkit` on every callable entry

Every subkit callable entry ships a `_meta.subkit` envelope:

```json
{ "category": "tenant_write", "confirm_required": true, "destructive": true }
```

- `category`: one of `tenant_read`, `tenant_write`, `draft_write`, `workflow_run`.
- `confirm_required`: the entry may require a local human decision. The actual call's input and current authority determine whether it pauses.
- `destructive`: a conservative effect hint, not proof that anybody approved the call. A replay trigger can be destructive even though it needs no new decision.

**Do not invent an approval prompt or infer approval from conversation text.** Use the engine's returned review channel. A client permission hint does not replace a product-local decision.

## Destructive-action flow (local decision, then exact replay)

**SubKit verifies its own human decision.** `destructiveHint` is advisory client metadata, not an authority. Autonomous preparation proceeds normally; a gated registry call returns `status: needs_confirm` with a `tool_call_id` and `approval_url`.

1. Call the entry normally with its exact arguments.
2. If the result needs confirmation, present the returned `approval_url` unchanged. A person signs in and grants or declines the bound request. The agent must not submit that decision.
3. Only after the human grants it, call `confirm_tool_call({tool, confirm_id})`, using `tool_call_id` as `confirm_id`. This claims the saved approval and replays the encrypted original arguments; do not add replacement arguments.
4. An ungranted, declined, expired, foreign or consumed approval cannot execute. Repeating the claim does not repeat the operation. If the reply is ambiguous, inspect the recorded outcome before proposing a new operation.

Use separate system-account credentials for agents. User login keys and browser cookies belong to the human login boundary and must not be shared with automation. A Bearer token alone cannot decide in the portal.

Conversation confirmations use engine-owned human elicitation or its browser fallback, never an outer tool annotation as blanket permission. A read-visible tool can still require confirmation when its input implies an external write.

Saved `wf_<slug>` execution is separate: a matching, unexpired local Execution Authority permits bounded live runs. Otherwise SubKit prepares a durable held-write run. A tool approval is not a standing authority for new versions, targets, credentials or repeated runs.

## Remote MCP servers the tenant registered

subkit is an MCP client as well as an MCP server, and the two directions do not meet in this catalog.

- A remote MCP server subkit calls is a **connector with `driver: "mcp"`** — endpoint in `base_url`, transport and auth shape in `config.mcp`, secret in the ordinary credential row. Manage it with the connector entries (`list_connectors`, `get_connector`, `update_connector`, `delete_connector`) and check it with `test_connector`, which handshakes and reports the tool count. There is no `mcp-servers` tool family and no `mcp_server:manage` permission; both were removed with the separate registry.
- Its remote tools are minted into the **chat palette** as `mcp_<connector_slug>__<remote_tool>`, alongside read-only `list_resources` / `list_resource_templates` / `read_resource` / `list_prompts` / `get_prompt` adapters for the capabilities the server declared (a server's own tool of the same name wins over an adapter). A workflow reaches the same remote through a `request` step carrying an `mcp` block. Neither address is callable from this MCP surface — do not name an `mcp_…` tool to a caller here, and do not tell them to "call it over MCP".
- Treat remote `tools/call` as an external effect requiring local authority, whatever the server's `readOnlyHint` claims. Neither a third-party hint nor an author's `side_effects: "read"` label is permission to bypass preparation's write hold.

## `warnings[]` on workflow runs

When a jsonata transform references an identifier that isn't in scope, subkit returns the partial output next to a `warnings` array:

```json
{
  "output": { "city": "Berlin, Germany" },
  "warnings": [
    {
      "code": "unresolved_identifier",
      "identifier": "data",
      "step_key": "format_output",
      "message": "jsonata expression referenced \"data\" but no matching key was in scope or bindings"
    }
  ]
}
```

- `code: "unresolved_identifier"` means the expression used a bare name that does not match any step id, any `$`-binding, or the `input` alias.
- Fix by renaming: a `request` step with `id: "fetch"` binds its response under `fetch`, not `data`. Or use `$input.foo` for workflow inputs.
- `code: "step_failed_continued"` means the step failed but the workflow author declared `on_error: "continue"` — the run is still a success. Report the tolerated failure to the operator; do not blindly retry or repair.

`warnings[]` is non-fatal — `status` stays `succeeded`. Surface it to the operator but do not retry blindly.

## Synthesised `inputSchema` for `wf_<slug>`

When a workflow does not declare `input_schema`, subkit scans the DAG:

- `${input.foo}` placeholders in request URL / path / headers / query / body strings.
- Jsonata `$input.foo` or bare `input.foo` references inside transforms and branch conditions.

The identifiers become `properties: { foo: {type: "string"} }` with `additionalProperties: true`. Pass anything the workflow references; strings are safe. Operators who want stricter typing declare `input_schema` on the DAG explicitly.

## Authoring sandbox code via MCP

When an MCP client submits JavaScript for a `transform` step or a before-request hook (e.g. through `update_workflow`, or the conversational authoring loop), prefer the `sk.*` stdlib surface over raw comparisons — `sk.http.isMutating(method)`, `sk.get(obj, path, fallback)`, `sk.allow()`, `sk.deny(reason)`. For base64, use `sk.base64Encode` / `sk.base64UrlEncode` only when preserving JSONata `$base64encode` byte output, and use `sk.base64EncodeUtf8` / `sk.base64UrlEncodeUtf8` for new Unicode text payloads; decode with `sk.base64Decode` / `sk.base64DecodeUtf8` (or the `atob` / `btoa` globals for binary strings). For hex use `sk.hexEncode` / `sk.hexDecode`; for hashing and signed-request auth use `sk.sha256` / `sk.hmacSha256`. For timestamps and ids use `sk.now()` / `sk.nowIso()` and `sk.uuid()` — `Date.now()`, `new Date()`, and `Math.random()` are absent by design.

**Never hand-roll base64, hex, or crypto** — do not propose a transform that embeds a base64/base32/hex alphabet literal or a reverse-lookup table; the authoring gate rejects it. Steer to `sk.base64*` / `sk.hex*` / `sk.sha256` / `sk.hmacSha256`. The full surface and rationale live in `workflow-authoring.md`. The stdlib is injected into every sandbox context, is frozen, versioned, and deterministic; proposing `sk.*`-based code keeps the policy surface uniform across tenants.
