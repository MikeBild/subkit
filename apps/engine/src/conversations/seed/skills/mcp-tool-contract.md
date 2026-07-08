---
slug: mcp-tool-contract
scope: global
title: MCP Callable Contract
description: Reference for sk's MCP callable surface — how callable entries are named, how a destructive call pauses on a human's approval at its `approval_url` and is then performed by `confirm_tool_call`, when to trust the synthesized `inputSchema`, and how to read the `warnings[]` envelope. Consult this before driving sk from any MCP client (Codex, Claude Desktop, Cursor, sk, etc.).
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

- **Bare snake_case names** — the operator surface. Reads (`list_workflows`, `get_connector`, …) and writes (`delete_workflow`, `revoke_api_key`, …). Use these for CRUD. Names never carry a `tenant_` prefix and never contain dots.
- **`wf_<slug>`** — run a specific workflow. Arguments match the workflow's declared `input_schema`; when absent, sk synthesises one from the DAG's `${input.X}` placeholders and jsonata `$input.X` references.
- **`conversation_*`** — multi-turn authoring sessions (`conversation_start`, `conversation_append`, `conversation_respond_elicitation`). Use these when the operator is **designing** a workflow or connector. Do NOT start a conversation for routine CRUD — the bare CRUD names are the cheap path.

## Reading `_meta.subkit` on every callable entry

Every sk callable entry ships a `_meta.subkit` envelope:

```json
{ "category": "tenant_write", "confirm_required": true, "destructive": true }
```

- `category`: one of `tenant_read`, `tenant_write`, `draft_write`, `workflow_run`.
- `confirm_required`: `true` → the first call returns a `needs_confirm` envelope and the callable entry does **not** execute. A HUMAN releases it, never you.
- `destructive`: UI hint. Surface a warning to the human before asking.

**Do not author your own `ask_user_confirm` before a callable entry whose `_meta.subkit.confirm_required` is already true.** The policy gate raises exactly one confirmation. Pre-empting it produces two elicitations and a stalled loop.

## Destructive-action flow (a person approves; you only trigger)

**You cannot approve anything.** An approval is granted by a human, out of band, in an approval portal. `confirm_tool_call` does not approve — it performs a call a person already approved. Until they do, it answers `approval_not_granted`.

1. Call the callable entry normally, e.g. `delete_workflow({id: "abc"})`.
2. sk replies with a structured envelope:
   ```json
   {
     "status": "needs_confirm",
     "tool": "delete_workflow",
     "policy_mode": "confirm_before_execution",
     "reason": "tool_default",
     "pending_output": { "workflow_id": "abc" },
     "tool_call_id": "<uuid>",
     "approval_url": "https://<engine>/v1/tool-approvals/decide?grant=skag_…"
   }
   ```
   Nothing ran. The envelope carries no `args` — the engine holds them. The handle is named `tool_call_id`; `approval_url` is `null` only when the deployment has no `server.public_base_url`, and then the call cannot be approved at all.
3. **Send `approval_url` to the person who must approve.** They open it, see exactly what will be written, and approve or decline. Do not paraphrase the link away; it is the only channel that can release the call.
4. Once they have approved, fire the trigger, passing the envelope's `tool_call_id` as `confirm_id`:
   ```json
   { "name": "confirm_tool_call", "arguments": { "tool": "delete_workflow", "confirm_id": "<uuid>" } }
   ```
   The engine replays the arguments it already holds under that id — never re-send them.
5. sk executes the callable entry, writes the `approval.approved` audit row, and returns the normal result.

If you fire the trigger before a person has approved, you get `error_code: "approval_not_granted"`. That is not a failure to retry around: it means the human has not decided yet. Wait, and do not re-issue the original call — that only opens a second approval.

**If your client answers elicitation**, the engine may also show the operator a confirmation inside the call, as an optimization over that round-trip:

- They accept → the call executes immediately; you never see the `needs_confirm` envelope at all.
- They decline → `error_code: "confirm_declined"`. Terminal. The approval is dead and cannot be revived. Report that; re-issue only if the user asks again.
- Your client advertises the capability and does not answer the prompt → you get the ordinary `needs_confirm` envelope above, with its `approval_url`. Nothing ran, and the engine has no decision from anyone. Say that; do not tell the user their approval was refused, and do not tell them nobody was asked.

There is no argument on any tool, and no `_meta` flag, that clears a confirmation gate. `_meta.sk_confirm` is the same trigger, and fails the same way on an ungranted approval.

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
