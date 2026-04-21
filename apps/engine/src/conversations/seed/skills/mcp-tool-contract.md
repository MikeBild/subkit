---
slug: mcp-tool-contract
scope: global
title: MCP Tool Contract
description: Reference for subkit's MCP tool surface — how tools are named, how destructive calls flow through `_meta.sk_confirm`, when to trust the synthesized `inputSchema`, and how to read the `warnings[]` envelope. Consult this before driving subkit from any MCP client (Codex, Claude Desktop, Cursor, sk, etc.).
gates_tools: []
version: 1
auto_load: true
trigger_keywords: [mcp tool, mcp tools, tenant delete, confirm_required, sk_confirm, ask_user_confirm, unresolved_identifier, warnings, input schema, wf., tenant., conversation.]
---

# Subkit MCP tool contract

Subkit exposes three families of tools over MCP. Calling them correctly saves round-trips and avoids duplicate confirmations.

## Tool families

- **`tenant.<name>`** — operator surface. Reads (`tenant.list_workflows`, `tenant.get_connector`, …) and writes (`tenant.delete_workflow`, `tenant.revoke_api_key`, …). Use these for CRUD.
- **`wf.<slug>`** — run a specific workflow. Arguments match the workflow's declared `input_schema`; when absent, subkit synthesises one from the DAG's `${input.X}` placeholders and jsonata `$input.X` references.
- **`conversation.*`** — multi-turn authoring sessions (`conversation.start`, `conversation.append`, `conversation.respond_elicitation`). Use these when the operator is **designing** a workflow or connector. Do NOT start a conversation for routine CRUD — the `tenant.*` surface is the cheap path.

## Reading `_meta.subkit` on every tool

Every subkit tool ships a `_meta.subkit` envelope:

```json
{ "category": "tenant_write", "confirm_required": true, "destructive": true }
```

- `category`: one of `tenant_read`, `tenant_write`, `workflow_run`.
- `confirm_required`: `true` → the first call returns a `pending` envelope and the tool does **not** execute until you re-issue with `_meta.sk_confirm: true`.
- `destructive`: UI hint. Surface a warning to the human before asking.

**Do not author your own `ask_user_confirm` before a tool whose `_meta.subkit.confirm_required` is already true.** The policy gate raises exactly one confirmation. Pre-empting it produces two elicitations and a stalled loop.

## Destructive-action flow (two MCP calls, one human confirmation)

1. Call the tool normally, e.g. `tenant.delete_workflow({id: "abc"})`.
2. Subkit replies with a structured envelope:
   ```json
   {
     "pending": true,
     "confirm_required": true,
     "policy_mode": "confirm_before_execution",
     "reason": "destructive_action",
     "target": { "tool": "tenant.delete_workflow", "args": { "id": "abc" } },
     "resume": "Re-issue the same call with _meta.sk_confirm=true after the operator approves.",
     "tool_call_id": "<uuid>"
   }
   ```
3. Relay the `target` + `destructive: true` hint to the operator. Wait for a human "yes".
4. Re-issue **the same call** with `_meta.sk_confirm: true`:
   ```json
   { "name": "tenant.delete_workflow", "arguments": {"id":"abc"}, "_meta": {"sk_confirm": true} }
   ```
5. Subkit runs the tool, writes the `approval.approved` audit row, and returns the normal tool result.

Aliases: setting `__policy_confirmed: true` inside the arguments has the same effect, kept for symmetry with the in-conversation authoring loop.

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

`warnings[]` is non-fatal — `status` stays `succeeded`. Surface it to the operator but do not retry blindly.

## Synthesised `inputSchema` for `wf.<slug>`

When a workflow does not declare `input_schema`, subkit scans the DAG:

- `${input.foo}` placeholders in request URL / path / headers / query / body strings.
- Jsonata `$input.foo` or bare `input.foo` references inside transforms and branch conditions.

The identifiers become `properties: { foo: {type: "string"} }` with `additionalProperties: true`. Pass anything the workflow references; strings are safe. Operators who want stricter typing declare `input_schema` on the DAG explicitly.
