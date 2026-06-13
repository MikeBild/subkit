---
slug: mcp-tool-contract
scope: global
title: MCP Callable Contract
description: Reference for sk's MCP callable surface — how callable entries are named, how destructive calls flow through `_meta.sk_confirm`, when to trust the synthesized `inputSchema`, and how to read the `warnings[]` envelope. Consult this before driving sk from any MCP client (Codex, Claude Desktop, Cursor, sk, etc.).
activates_when: [{"kind":"baseline"},{"kind":"intent_keyword","word":"mcp tool"},{"kind":"intent_keyword","word":"mcp tools"},{"kind":"intent_keyword","word":"tenant delete"},{"kind":"intent_keyword","word":"confirm_required"},{"kind":"intent_keyword","word":"sk_confirm"},{"kind":"intent_keyword","word":"ask_user_confirm"},{"kind":"intent_keyword","word":"unresolved_identifier"},{"kind":"intent_keyword","word":"warnings"},{"kind":"intent_keyword","word":"input schema"},{"kind":"intent_keyword","word":"wf_"},{"kind":"intent_keyword","word":"tenant_"},{"kind":"intent_keyword","word":"conversation_"}]
side_effects: read
idempotency: none
maturity: stable
tags: [mcp, contract]
version: 3
---

# sk MCP callable contract

sk exposes three families of callable entries over MCP. Calling them correctly saves round-trips and avoids duplicate confirmations.

## Callable families

- **`tenant_<name>`** — operator surface. Reads (`tenant_list_workflows`, `tenant_get_connector`, …) and writes (`tenant_delete_workflow`, `tenant_revoke_api_key`, …). Use these for CRUD.
- **`wf_<slug>`** — run a specific workflow. Arguments match the workflow's declared `input_schema`; when absent, sk synthesises one from the DAG's `${input.X}` placeholders and jsonata `$input.X` references.
- **`conversation_*`** — multi-turn authoring sessions (`conversation_start`, `conversation_append`, `conversation_respond_elicitation`). Use these when the operator is **designing** a workflow or connector. Do NOT start a conversation for routine CRUD — the `tenant_*` surface is the cheap path.

## Reading `_meta.sk` on every callable entry

Every sk callable entry ships a `_meta.sk` envelope:

```json
{ "category": "tenant_write", "confirm_required": true, "destructive": true }
```

- `category`: one of `tenant_read`, `tenant_write`, `workflow_run`.
- `confirm_required`: `true` → the first call returns a `pending` envelope and the callable entry does **not** execute until you re-issue with `_meta.sk_confirm: true`.
- `destructive`: UI hint. Surface a warning to the human before asking.

**Do not author your own `ask_user_confirm` before a callable entry whose `_meta.sk.confirm_required` is already true.** The policy gate raises exactly one confirmation. Pre-empting it produces two elicitations and a stalled loop.

## Destructive-action flow (two MCP calls, one human confirmation)

1. Call the callable entry normally, e.g. `tenant_delete_workflow({id: "abc"})`.
2. sk replies with a structured envelope:
   ```json
   {
     "pending": true,
     "confirm_required": true,
     "policy_mode": "confirm_before_execution",
     "reason": "destructive_action",
     "target": { "tool": "tenant_delete_workflow", "args": { "id": "abc" } },
     "resume": "Re-issue the same call with _meta.sk_confirm=true after the operator approves.",
     "tool_call_id": "<uuid>"
   }
   ```
3. Relay the `target` + `destructive: true` hint to the operator. Wait for a human "yes".
4. Re-issue **the same call** with `_meta.sk_confirm: true`:
   ```json
   { "name": "tenant_delete_workflow", "arguments": {"id":"abc"}, "_meta": {"sk_confirm": true} }
   ```
5. sk executes the callable entry, writes the `approval.approved` audit row, and returns the normal result.

Aliases: setting `__policy_confirmed: true` inside the arguments has the same effect, kept for symmetry with the in-conversation authoring loop.

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

When an MCP client submits JavaScript for a `transform` step or a before-request hook (e.g. through `tenant_create_request_hook`, `tenant_update_workflow`, or the conversational authoring loop), prefer the `sk.*` stdlib surface over raw comparisons — `sk.http.isMutating(method)`, `sk.get(obj, path, fallback)`, `sk.allow()`, `sk.deny(reason)`. For base64, use `sk.base64Encode` / `sk.base64UrlEncode` only when preserving JSONata `$base64encode` byte output, and use `sk.base64EncodeUtf8` / `sk.base64UrlEncodeUtf8` for new Unicode text payloads. The full surface and rationale live in `workflow-authoring.md`. The stdlib is injected into every sandbox context, is frozen, versioned, and deterministic; proposing `sk.*`-based code keeps the policy surface uniform across tenants.
