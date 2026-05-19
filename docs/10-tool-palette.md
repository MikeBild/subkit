# Tool palette and dispatch

> **Status:** authoritative as of 2026-05-19. See
> [`apps/engine/src/tools/`](../apps/engine/src/tools/) for the
> implementation and `AGENTS.md` lines 142–185 for the subsystem map.

## Why this exists

The engine speaks "LLM tool-calling" across two surfaces:

- **Chat** — Anthropic-SDK tool calls inside a conversation turn,
  invoked through `apps/engine/src/conversations/tools/sdk-wrap.ts`.
- **MCP** — `tools/list` + `tools/call` over the Model Context Protocol,
  served by `apps/engine/src/mcp/`.

Before this design, the two paths duplicated dispatch, schema, RBAC,
audit, and policy. The most visible artifact: `test_connector` lived
as a `ConversationTool` (`conversations/tools/test-connector.ts`) AND
as a separate MCP-only file (`mcp/tools/test-connector.ts`). Both
called the same `probeConnector()` driver and the same
`recordConnectorInvoked()` audit recorder.

Worse than the literal duplication: each surface ran a *different*
policy gate. Chat used `tool-policies.resolveToolMode()`; MCP used
`mcp/capabilities/policy-gate.gateTenantToolCall()`. Those two
functions disagreed on `tenant_read` escalations — `probe_connector`
POST against prod gated correctly on chat and silently bypassed on
MCP, because the MCP gate shortcut'd every `tenant_read` to "proceed".

The unified palette closes both gaps with one registry, one
dispatcher, one policy gate, and one envelope shape — and per-surface
adapters that render the envelope into MCP transport vs. chat SDK
shape.

## Concepts

### ToolDescriptor

```ts
interface ToolDescriptor {
  name: string;
  description: string;
  category: "draft_write" | "tenant_read" | "tenant_write";
  inputSchema: unknown; // Zod for conversation tools; JSON Schema for static
  disabled?: { reason: string };
  requires_skill?: string;
}
```

The `category` drives policy decisions (see *Policy gate* below). The
`disabled` field is the **honest signal**: a tool can appear in
`tools/list` while `tools/call` rejects it with a structured envelope.
We use it for draft-write tools on MCP — operators see the tool exists
but learn it's not callable headlessly.

### Surface

`"chat" | "mcp"` — drives visibility filtering and envelope rendering.
No surface-specific logic in the dispatcher itself; per-surface concerns
live in adapters.

### ToolEnvelope (status-discriminated)

```ts
type ToolEnvelope =
  | { status: "ok"; data: unknown; pause?; committed_workflow_id? }
  | { status: "error"; error_code; message; details?; next_best_actions? }
  | { status: "needs_confirm"; confirm: ConfirmEnvelope }
  | { status: "paused"; pause: ToolResultPause }
  | { status: "not_available_on_surface"; reason: string };
```

Replaces the legacy `ok: true | false` discriminated union from
`conversations/tools/index.ts:178`. The status discriminator makes the
surface adapters trivially total — each adapter has one case per
status.

### Provider, Registry, Dispatcher

Providers contribute descriptors + executors:

- `StaticToolProvider` — MCP-unique handlers: `authenticate`,
  `list_recipes`, `self_healing.scan`.
- `ConversationToolProvider` — everything in
  `conversations/tools/index.ts:listTools()`, filtered per
  `(surface, mcpMode, readOnly)`.

`buildRegistry(providers)` enforces cross-provider name uniqueness at
boot. `registry.get(name, filter)` resolves an executor; `registry.list(filter)`
gives the visible catalog.

`dispatchTool(deps, invocation)` runs the pipeline:

1. **resolve** — registry lookup → `tool_not_found` envelope on miss.
2. **visibility** — `descriptor.disabled` → `not_available_on_surface`.
3. **policy** — `policyDecide()` → `proceed | needs_confirm | not_available`.
4. **audit** — `APPROVAL_REQUESTED` / `APPROVAL_APPROVED` rows.
5. **execute** — call the resolved executor.
6. **normalize** — wrap result in `ToolEnvelope`.
7. **log** — one `tool.dispatch.invoke` event per call.

### Policy gate (unified)

`policyDecide()` is a **pure synchronous function** that subsumes both
`resolveToolMode()` (chat) and `gateTenantToolCall()` (MCP). Audit is
emitted by the dispatcher, not the gate.

```ts
type PolicyDecision =
  | { kind: "proceed" }
  | { kind: "needs_confirm"; envelope: ConfirmEnvelope }
  | { kind: "not_available_on_surface"; reason: string };
```

Key behavioral change vs. the legacy paths: **no `tenant_read` shortcut**.
The legacy MCP gate (`policy-gate.ts:84`) returned `proceed` for every
`tenant_read` tool, ignoring `computeModeFromInput` predicates. The
unified gate consults `resolveToolMode` for every category, so
`probe_connector` POST against prod gates correctly on both surfaces.

## Adapters

### MCP adapter (`mcp/adapter.ts`)

- `listToolsViaRegistry(opts)` → `Tool[]` for `tools/list`.
- `callToolViaDispatcher(opts)` → `{isError, content[], _meta}` for `tools/call`.
- `buildMcpStubCtx(opts)` → a minimal `ToolContext` so conversation
  tools (which are designed for an in-conversation draft) can run
  against an MCP caller without a real conversation session.

Envelope rendering:

| ToolEnvelope.status        | MCP response                                                                                  |
|----------------------------|-----------------------------------------------------------------------------------------------|
| `ok`                       | `{isError:false, content:[text(JSON.stringify(data))]}`                                       |
| `error`                    | `{isError:true,  content:[text({error_code, message, details, next_best_actions})]}`          |
| `needs_confirm`            | `{isError:false, content:[text(confirm)], _meta:{subkit:{confirm}}}`                          |
| `paused`                   | `{isError:false, content:[text(pause)],   _meta:{subkit:{paused}}}`                           |
| `not_available_on_surface` | `{isError:true,  content:[text({error_code:"not_available_on_surface", reason})], _meta:...}` |

### Chat adapter (`conversations/tools/dispatch-adapter.ts`)

- `invokeForSdk(opts)` — single entry point available for the chat
  loop. **Not wired into `sdk-wrap.ts` yet** — the chat path remains
  on its existing inline wrapping (which owns rate-limiting, signal
  handling, event emission, and draft-state diff emission). The adapter
  exists so a future cutover can land in one focused change.
- `envelopeToToolResult(envelope)` — back-converts to the legacy
  `ToolResult` shape the conversation loop expects today. The `needs_confirm`
  case becomes an `ask_user_confirm` pause so the elicitation loop
  picks it up unchanged.

## Decisions and trade-offs

### Probe + test stay separate (no merge)

`test_connector` (driver health), `probe_connector` (caller-specified
HTTP on saved connector), and `probe_connector_draft` (caller HTTP on
pre-creation envelope) are **three semantically distinct operations**.
The early plan considered merging probe+test under one tool with a
`mode` arg; the audit found two RBAC permissions, two audit shapes,
and two rate-limit semantics — merging them hides operational distinctions
under one schema. We keep all three names; the MCP-side duplicate of
`test_connector` is the only thing deleted.

### `save_workflow_draft` and `dry_run_workflow` defer MCP exposure

Both surface in MCP `tools/list` with
`_meta.subkit.disabled.reason="requires_conversation_surface"`. The
former needs an MCP-side confirm protocol that doesn't exist (current
`ask_user_confirm` elicitation is conversation-shaped); the latter
needs a `def`/`draft_id` input schema extension (currently it only
reads `ctx.getDraft()`). Building speculative cross-surface confirm
tokens for zero callers violates the no-speculation rule.

### Status-discriminated envelope vs. flat `ok` boolean

The legacy `ToolResult` carried `pause` on both `ok:true` and `ok:false`
branches — an awkward shape because "paused but failed" is not a real
state. Status discrimination makes the four valid states explicit and
totally narrowable.

### No HTTP `/v1/tools/:name` surface (yet)

The dispatcher is surface-agnostic, but adding a third per-surface
adapter without a caller violates YAGNI. When an HTTP caller appears,
the adapter is a 40-line file.

### Audit lives in the dispatcher

`policyDecide()` is pure. Audit emission (`APPROVAL_REQUESTED`,
`APPROVAL_APPROVED`) happens in the dispatcher around the policy
decision. This keeps the gate testable without DB and centralizes the
audit semantics. Per-tool audits (e.g., `recordConnectorInvoked` inside
`test_connector`) continue to fire from inside the tool's executor.

## Reference implementation comparison

A peer integration platform was audited during the design phase.
Subkit wins on every axis; headline differences:

- Subkit is **Zod-first end-to-end**; ref-impl converts JSON Schema →
  Zod at MCP registration.
- Subkit's confirmation is **backend-driven** (returns a structured
  `ConfirmEnvelope` to every surface); ref-impl decides on the frontend
  and has no backend protocol for headless clients.
- Subkit emits **structured `error_code`s with `next_best_actions`**;
  ref-impl returns free-text error strings.
- Subkit **audits every confirm-gated MCP call** (`APPROVAL_REQUESTED`,
  `APPROVAL_APPROVED` correlated by `tool_call_id`) plus per-tool
  domain audits like `connector.invoked` from inside `test_connector`;
  ref-impl's MCP server has no audit trail (only chat runs persist).
  Read-only MCP calls produce a structured `tool.dispatch.invoke` log
  line, not an audit row — adding `MCP_TOOL_INVOKED` is a future
  enhancement when SOC2 evidence demands it.
- Subkit's RBAC is **per-permission via `can()`**; ref-impl uses
  skill-loading + role→toolId arrays.

## Layout

```
apps/engine/src/tools/
├── types.ts                    ToolDescriptor, ToolEnvelope, ToolInvocation, etc.
├── registry.ts                 ToolRegistry interface + buildRegistry()
├── policy.ts                   policyDecide() — pure unified policy gate
├── dispatcher.ts               dispatchTool() — the orchestrator
├── index.ts                    barrel
├── providers/
│   ├── static.ts               StaticToolProvider — MCP-unique handlers
│   └── conversation.ts         ConversationToolProvider — listTools() wrapper
└── tests/
    ├── registry.test.ts
    ├── dispatcher.test.ts
    ├── policy-decide.test.ts
    ├── result-shape-invariants.test.ts
    └── cross-surface-parity.test.ts

apps/engine/src/mcp/
├── adapter.ts                  listToolsViaRegistry / callToolViaDispatcher
└── tests/
    ├── tools-call-parity.test.ts
    ├── policy-gate-snapshot.test.ts
    ├── tools-list-disabled.test.ts
    ├── preview-attachment-flat-name.test.ts
    └── test-connector-dedupe.test.ts

apps/engine/src/conversations/tools/
├── dispatch-adapter.ts         invokeForSdk / envelopeToToolResult
└── tests/
    └── dispatcher-parity.test.ts
```

## Cross-refs

- `docs/02-concepts.md` — vocabulary (workflow, connector, skill).
- `docs/03-input-surfaces.md` — how chat/MCP/HTTP surfaces map to the
  conversation loop.
- `docs/07-security-governance.md` — RBAC, audit, policy.
- `AGENTS.md` lines 142–185 — subsystem map (the row for `tools` lives
  here).

## Cutover plan

Tests-first: characterization tests in `mcp/tests/policy-gate-snapshot.test.ts`
and `mcp/tests/tools-call-parity.test.ts` pin current behavior. The
new-behavior tests in `apps/engine/src/tools/tests/` and the new MCP
tests are `test.todo` until their implementation commit lands.

The cutover in `mcp/capabilities/tools.ts` inserts a single early-return
that delegates to `mcp/adapter.callToolViaDispatcher()` for any tool the
unified registry recognizes; everything else falls through to the
legacy prefix proxies (`tenant.*`, `conversation.*`, `wf.<slug>`). The
named-tool branches (authenticate, list_recipes, test_connector, etc.)
have all been deleted — the registry claims those names exclusively.

Backward compatibility is preserved on two surfaces:

- `tenant.<name>` prefix alias — every conversation tool reachable
  under its bare name through the dispatcher is *also* reachable under
  `tenant.<name>` via the legacy proxy in `capabilities/tools.ts`. Both
  paths emit the same audit row; the alias is the contract for
  pre-cutover MCP clients.
- `conversation.*` session-management tools (`conversation.start`,
  `conversation.append`, `conversation.commit`,
  `conversation.respond_elicitation`) remain on the legacy path because
  they are MCP-specific session orchestration, not LLM tool palette
  items.

The chat side keeps its existing `sdk-wrap.ts` inline path; the
`dispatch-adapter.invokeForSdk` entry exists for a future focused
cutover but is not invoked at runtime yet.
