---
slug: mcp-tool-contract
scope: global
title: MCP Callable Contract
description: Reference for sk's MCP callable surface — how callable entries are named, how a destructive call is gated by your MCP client's own native approval dialog (from the tool's `destructiveHint` annotation) and then executes directly, when to trust the synthesized `inputSchema`, and how to read the `warnings[]` envelope. Consult this before driving sk from any MCP client (Codex, Claude Desktop, Cursor, sk, etc.).
activates_when: [{"kind":"baseline"},{"kind":"intent_keyword","word":"mcp tool"},{"kind":"intent_keyword","word":"mcp tools"},{"kind":"intent_keyword","word":"tenant delete"},{"kind":"intent_keyword","word":"confirm_required"},{"kind":"intent_keyword","word":"sk_confirm"},{"kind":"intent_keyword","word":"ask_user_confirm"},{"kind":"intent_keyword","word":"unresolved_identifier"},{"kind":"intent_keyword","word":"warnings"},{"kind":"intent_keyword","word":"input schema"},{"kind":"intent_keyword","word":"wf_"},{"kind":"intent_keyword","word":"tenant_"},{"kind":"intent_keyword","word":"conversation_"}]
side_effects: read
idempotency: none
maturity: stable
tags: [mcp, contract]
version: 6
---

# sk MCP callable contract

sk exposes three families of callable entries over MCP. Calling them correctly saves round-trips and avoids duplicate confirmations.

## Callable families

- **Bare snake_case names** — the operator surface. Reads (`list_workflows`, `get_connector`, …) and writes (`delete_workflow`, `revoke_api_key`, …). Use these for CRUD. Names never carry a `tenant_` prefix and never contain dots.
- **`wf_<slug>`** — run a specific workflow. Arguments match the workflow's declared `input_schema`; when absent, sk synthesises one from the DAG's `${input.X}` placeholders and jsonata `$input.X` references.
- **`conversation_*`** — multi-turn authoring sessions (`conversation_start`, `conversation_append`, `conversation_respond_elicitation`). Use these when the operator is **designing** a workflow or connector. Do NOT start a conversation for routine CRUD — the bare CRUD names are the cheap path.

The FULL authoring catalog is advertised — `tools/list` publishes every tool the mode exposes, with no server-side trim. When a client caps how many tools it preloads, its OWN native tool-search / defer-loading fetches any remaining tool on demand; you do not need a discovery meta-tool. For workflows use `find_workflow`; for connectors use `find_connector` (these search tenant DATA, not the tool catalog).

**claude.ai CACHES `tools/list`.** After an engine upgrade that changes the catalog, claude.ai keeps serving the old cached tool list — new tools will NOT appear until the user **removes and re-adds the connector** (GitHub claude-ai-mcp #137). If a documented tool is missing after an upgrade, that stale cache is the cause; tell the user to remove + re-add the connector.

## Reading `_meta.subkit` on every callable entry

Every sk callable entry ships a `_meta.subkit` envelope:

```json
{ "category": "tenant_write", "confirm_required": true, "destructive": true }
```

- `category`: one of `tenant_read`, `tenant_write`, `draft_write`, `workflow_run`.
- `confirm_required`: `true` → this entry writes/mutates, so its `tools/list` annotation carries `destructiveHint: true`. Your MCP client gates it with its OWN native approval dialog (see below). It is a hint about how YOUR client behaves, not a signal that sk returns a pending envelope.
- `destructive`: same signal, mirrored for clients that read the vendor block.

**Do not author your own `ask_user_confirm`/approval prompt before a write.** Your client already renders one from the `destructiveHint` annotation. Pre-empting it just double-prompts the human.

## Destructive-action flow (your client gates it; sk executes it)

**The human approves inside YOUR client, before the call ever reaches sk.** Every write/destructive entry advertises `destructiveHint: true` in its `tools/list` annotations. A trusted MCP client (claude.ai, ChatGPT, Claude Desktop, Cursor, …) reads that hint and renders a native, per-call approval dialog *before* dispatching the call — a blocking human gate you cannot bypass. There is **no** sk-side approval portal, **no** `approval_url`, **no** `confirm_tool_call`, and **no** `needs_confirm` envelope. Those were removed.

1. Call the callable entry normally, e.g. `delete_workflow({id: "abc"})`.
2. Your client shows the human its approval prompt (e.g. claude.ai: *"Claude wants to use delete_workflow — Allow / Deny"*; ChatGPT surfaces the same under its permission mode). You do not send a link or paste anything — the client owns this step.
3. If the human **allows**, the call reaches sk and **executes directly**, writing its audit row and returning the normal result. If they **deny**, the call never reaches sk.
4. That is the whole flow. Do not look for an `approval_url` to forward, and do not call `confirm_tool_call` — it no longer exists. Just make the call and let the client's dialog gate it.

If a write does not seem to run, the human declined in the client dialog, or the connector's tool-permission is set to block. Re-issuing the identical call simply re-prompts them — it does not open any server-side approval.

**Grant channel = the client dialog, not sk.** Even if your client advertises `elicitation`, sk issues no in-band prompt of its own: the `destructiveHint` annotation is the entire mechanism, and it is honored client-side. (The chat surface — not MCP — is the exception: there sk raises an `ask_user_confirm` elicitation over its own HTTP channel.)

## `warnings[]` on workflow runs

When a jsonata transform references an identifier that isn't in scope, sk returns the partial output next to a `warnings` array:

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

`warnings[]` is non-fatal — `status` stays `succeeded`. Surface it to the operator but do not retry blindly.

## Synthesised `inputSchema` for `wf_<slug>`

When a workflow does not declare `input_schema`, sk scans the DAG:

- `${input.foo}` placeholders in request URL / path / headers / query / body strings.
- Jsonata `$input.foo` or bare `input.foo` references inside transforms and branch conditions.

The identifiers become `properties: { foo: {type: "string"} }` with `additionalProperties: true`. Pass anything the workflow references; strings are safe. Operators who want stricter typing declare `input_schema` on the DAG explicitly.

## Authoring sandbox code via MCP

When an MCP client submits JavaScript for a `transform` step or a before-request hook (e.g. through `update_workflow`, or the conversational authoring loop), prefer the `sk.*` stdlib surface over raw comparisons — `sk.http.isMutating(method)`, `sk.get(obj, path, fallback)`, `sk.allow()`, `sk.deny(reason)`. For base64, use `sk.base64Encode` / `sk.base64UrlEncode` only when preserving JSONata `$base64encode` byte output, and use `sk.base64EncodeUtf8` / `sk.base64UrlEncodeUtf8` for new Unicode text payloads; decode with `sk.base64Decode` / `sk.base64DecodeUtf8` (or the `atob` / `btoa` globals for binary strings). For hex use `sk.hexEncode` / `sk.hexDecode`; for hashing and signed-request auth use `sk.sha256` / `sk.hmacSha256`. For timestamps and ids use `sk.now()` / `sk.nowIso()` and `sk.uuid()` — `Date.now()`, `new Date()`, and `Math.random()` are absent by design.

**Never hand-roll base64, hex, or crypto** — do not propose a transform that embeds a base64/base32/hex alphabet literal or a reverse-lookup table; the authoring gate rejects it. Steer to `sk.base64*` / `sk.hex*` / `sk.sha256` / `sk.hmacSha256`. The full surface and rationale live in `workflow-authoring.md`. The stdlib is injected into every sandbox context, is frozen, versioned, and deterministic; proposing `sk.*`-based code keeps the policy surface uniform across tenants.
