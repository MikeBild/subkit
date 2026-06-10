// Synthetic `mcp_<ns>__<tool>` tools for the chat palette (#171).
//
// Every active external MCP server a tenant registered has its tools
// merged into the chat LLM's palette so a user message that names a
// remote tool dispatches in ONE tool call. The per-tenant Client pool
// (`apps/engine/src/mcp/client/pool.ts`) owns the live connections,
// manifests, credentials, and result truncation; this module converts
// each `RemoteToolDescriptor` into an AI SDK `Tool` whose `execute`
// follows the EXACT side-effect sequence the in-repo wrappers use:
//
//   1. acquire the `signals.toolChain` mutex (serialise the turn)
//   2. enforce `mcp_external_tool:invoke` (RBAC `can`)
//   3. resolve approval via the SAME pending/confirm envelope the
//      synthetic `wf_<slug>` palette and MCP `gateTenantToolCall` use —
//      so `permission_mode` + the `mcp_` policy gate it identically
//   4. on confirm, call `pool.invokeRemoteTool`
//   5. PERSIST THE FULL remote content into the tool-call row (the
//      remote payload is verbatim — no wall-clock / random — so replay
//      is deterministic), and feed only a TRUNCATED view to the model
//   6. emit `tool_call_start` / `tool_call_end` / `tool_result`
//
// Tool name grammar is `mcp_<namespace>__<remote_tool>`. The namespace
// is `__`-free by a DB CHECK on `mcp_servers`, so the `__` separator is
// an unambiguous split point. The `mcp_` prefix is what the policy
// resolver keys on (`isDangerousTool` + `getApprovalMode`) to force
// "asks before running" under auto/ask/plan.

import { jsonSchema, type Tool, tool } from "ai";
import { recordMcpExternalToolPaletteAssemblyFailed } from "../../../audit/recorders/index.ts";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import { logger } from "../../../logging/logger.ts";
import { gateTenantToolCall } from "../../../mcp/capabilities/policy-gate.ts";
import {
  getTenantMcpTools,
  invokeRemoteTool,
  type RemoteToolDescriptor,
} from "../../../mcp/client/pool.ts";
import { recordConversationToolCall } from "../../../observability/instrumentation.ts";
import { can } from "../../../rbac/evaluator.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../../persist.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { truncateForLlm } from "../truncate.ts";
import type { TurnSignals, WrappedToolOutput } from "./state.ts";

const TOOL_PREFIX = "mcp_";
const NAMESPACE_SEP = "__";

export interface BuildExternalMcpToolsParams {
  db: Db;
  principal: ResolvedPrincipal;
  ctx: ToolContext;
  signals: TurnSignals;
  events: TurnEvent[];
}

// ── TEST SEAM ────────────────────────────────────────────────────────────────
// Replaces the whole palette assembly (`buildExternalMcpTools` consults the
// override on entry). Production never sets this; tests inject a failing/fake
// builder WITHOUT bun's `mock.module` (module mocks are process-global and
// leak into every other test file in the same worker). Null by default, so a
// missed restore can never alter production behavior — but tests MUST still
// restore null in afterAll. The override must not call back into
// `buildExternalMcpTools` itself (it would recurse).

type ExternalMcpToolsBuilder = (
  p: BuildExternalMcpToolsParams,
) => Promise<Record<string, Tool<Record<string, unknown>, WrappedToolOutput>>>;

let builderOverride: ExternalMcpToolsBuilder | null = null;

export function __setExternalMcpToolsBuilderForTests(fn: ExternalMcpToolsBuilder | null): void {
  builderOverride = fn;
}

/**
 * Build `mcp_<ns>__<tool>` SDK tools for the principal's tenant. Returned
 * map is keyed by the prefixed name and ready to splice into the AI SDK
 * `toolSet`. Empty when the tenant has no active external MCP servers (or
 * all are inside a backoff window). A handshake failure for one server is
 * swallowed by the pool — its tools are simply absent this turn.
 */
export async function buildExternalMcpTools(
  p: BuildExternalMcpToolsParams,
): Promise<Record<string, Tool<Record<string, unknown>, WrappedToolOutput>>> {
  // TEST SEAM consumption (see `__setExternalMcpToolsBuilderForTests` above):
  // production always falls through to the real assembly.
  if (builderOverride) return builderOverride(p);
  const servers = await getTenantMcpTools(p.db, p.principal.tenant_id, { requestSource: "chat" });
  const out: Record<string, Tool<Record<string, unknown>, WrappedToolOutput>> = {};
  for (const server of servers) {
    for (const descriptor of server.tools) {
      const name = `${TOOL_PREFIX}${server.namespace}${NAMESPACE_SEP}${descriptor.name}`;
      out[name] = buildOneExternalMcpTool({
        ...p,
        name,
        namespace: server.namespace,
        mcp_server_id: server.mcp_server_id,
        descriptor,
      });
    }
  }
  return out;
}

interface BuildOneParams extends BuildExternalMcpToolsParams {
  name: string;
  namespace: string;
  mcp_server_id: string;
  descriptor: RemoteToolDescriptor;
}

function buildOneExternalMcpTool(
  p: BuildOneParams,
): Tool<Record<string, unknown>, WrappedToolOutput> {
  const { descriptor, signals } = p;
  return tool<Record<string, unknown>, WrappedToolOutput>({
    description: `${descriptor.description} — external MCP tool (namespace ${p.namespace}). Asks for confirmation before running.`,
    inputSchema: jsonSchema(descriptor.inputSchema as Parameters<typeof jsonSchema>[0]),
    async execute(rawArgs: Record<string, unknown>): Promise<WrappedToolOutput> {
      // Serialise against other tool executions in this turn — identical
      // to the `wf_<slug>` synthetic wrapper and `wrapOne`'s mutex.
      const prevChain = signals.toolChain;
      let release!: () => void;
      signals.toolChain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prevChain;
      try {
        return await executeExternalMcpTool({ ...p, rawArgs });
      } finally {
        release();
      }
    },
  });
}

async function executeExternalMcpTool(
  p: BuildOneParams & { rawArgs: Record<string, unknown> },
): Promise<WrappedToolOutput> {
  const {
    ctx,
    signals,
    events,
    db,
    name,
    namespace,
    mcp_server_id,
    descriptor,
    principal,
    rawArgs,
  } = p;
  const startedAt = Date.now();

  // Defence in depth — production callers always source ctx.tenant_id and
  // principal.tenant_id from the same auth resolution. A mismatch means an
  // upstream refactor broke the invariant; fail loud at the dispatch
  // boundary rather than write audit / invoke rows for the wrong tenant.
  if (ctx.tenant_id !== principal.tenant_id) {
    // Land a durable trail under the auth-resolved tenant before failing.
    // Best-effort: a broken invariant must surface as the throw below — the
    // audit write can never mask it.
    try {
      await recordMcpExternalToolPaletteAssemblyFailed({
        tenant_id: principal.tenant_id,
        actor_id: ctx.actor_id,
        reason: "tenant_mismatch",
        request_source: "chat",
        executor: db,
      });
    } catch (auditErr) {
      logger.warn({
        module: "conversation_tool",
        action: "external_mcp.tenant_mismatch_audit_failed",
        msg: "failed to audit external MCP tenant mismatch; the dispatch still fails loud",
        tenant_id: principal.tenant_id,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
    throw new Error(
      `external mcp dispatch: ctx.tenant_id (${ctx.tenant_id}) !== principal.tenant_id (${principal.tenant_id})`,
    );
  }

  // Anchor an assistant message + tool-call row so this dispatch shows up
  // in the same persisted trail real tool calls produce.
  const ensureAnchor = async (): Promise<string> => {
    if (signals.assistantMessageId) return signals.assistantMessageId;
    const messageId = await appendMessage(db, ctx.tenant_id, ctx.conversation_id, "assistant", {});
    signals.assistantMessageId = messageId;
    return messageId;
  };
  const assistantMessageId = await ensureAnchor();
  const toolCallId = await insertToolCall(db, {
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    parent_message_id: assistantMessageId,
    tool: name,
    input: rawArgs,
    approval_required: false,
  });
  events.push({
    type: "tool_call_start",
    call_id: toolCallId,
    tool: name,
    input_partial: rawArgs,
    parent_message_id: assistantMessageId,
  });
  events.push({
    type: "tool_call_end",
    call_id: toolCallId,
    input: rawArgs,
    parent_message_id: assistantMessageId,
  });

  // RBAC gate — members may invoke tools an admin already registered, but
  // a principal lacking `mcp_external_tool:invoke` is refused before any
  // outbound call leaves the tenant perimeter.
  const decision = await can(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission: "mcp_external_tool:invoke",
  });
  if (!decision.allow) {
    const output: Record<string, unknown> = {
      ok: false,
      denied: true,
      permission: "mcp_external_tool:invoke",
      reason: decision.reason ?? "permission_denied",
      status: "failed",
    };
    await updateToolCallOutput(db, toolCallId, output);
    events.push({
      type: "tool_result",
      call_id: toolCallId,
      tool: name,
      output,
      parent_message_id: assistantMessageId,
    });
    recordConversationToolCall({
      category: "tenant_write",
      tool: name,
      outcome: "denied",
      duration_ms: Date.now() - startedAt,
    });
    return { ok: false, data: output };
  }

  // Policy gate — identical contract to MCP's `gateTenantToolCall` and the
  // synthetic `wf_<slug>` palette. The LLM re-issues with
  // `__policy_confirmed: true` after the operator confirms. `tool` stays
  // the prefixed name so the policy resolver's `mcp_` gate fires (forced
  // confirm under auto/ask/plan); `category: tenant_write` means a read
  // never short-circuits it.
  const gate = await gateTenantToolCall({
    tool: name,
    category: "tenant_write",
    args: rawArgs,
    meta: undefined,
    principal,
    db,
    via: "chat",
  });

  if (gate.kind === "pending") {
    // Operator-facing confirm summary: tool identity + input FIELD NAMES
    // only, mirroring run_workflow's buildPendingOutput (`input_keys`).
    // NEVER the input values — external tool args are bound for a
    // third-party server and may carry sensitive data, so the pending
    // envelope must not echo them back as a raw JSON blob. The LLM
    // re-issues the original call itself after the operator confirms, so
    // the echoed target needs no args either.
    const { __policy_confirmed: _marker, ...pendingInput } = rawArgs;
    const output: Record<string, unknown> = {
      pending: true,
      status: "awaiting_confirmation",
      policy_mode: "confirm_before_execution",
      confirm_required: true,
      target: { tool: gate.envelope.target.tool },
      tool_call_id: gate.envelope.tool_call_id,
      resume: gate.envelope.resume,
      namespace,
      remote_tool: descriptor.name,
      pending_output: {
        namespace,
        remote_tool: descriptor.name,
        input_keys: Object.keys(pendingInput),
      },
    };
    await updateToolCallOutput(db, toolCallId, output);
    events.push({
      type: "tool_result",
      call_id: toolCallId,
      tool: name,
      output,
      parent_message_id: assistantMessageId,
    });
    recordConversationToolCall({
      category: "tenant_write",
      tool: name,
      outcome: "pending",
      duration_ms: Date.now() - startedAt,
    });
    return { ok: false, data: output };
  }

  // Strip the confirmation marker before forwarding the args to the
  // remote tool so its input contract stays clean.
  const { __policy_confirmed: _confirmed, ...remoteInput } = rawArgs;

  ctx.onLog?.("info", `invoking external MCP tool ${name}`);
  const invoked = await invokeRemoteTool({
    db,
    tenant_id: ctx.tenant_id,
    // Attribute the `mcp_external_tool.invoked` audit row to the chat
    // principal that drove this turn — never a blurred system actor.
    actor_id: principal.id,
    mcp_server_id,
    namespace,
    remote_tool: descriptor.name,
    input: remoteInput,
    requestSource: "chat",
    // `recordMcpExternalToolInvoked` is emitted INSIDE `invokeRemoteTool`
    // with outcome / duration_ms / byte_count — the pool owns that audit
    // so the byte count is the raw remote size, not the truncated view.
  });

  // Persist the FULL remote content verbatim into the tool-call row. The
  // pool injects no wall-clock / random, so a replay rehydrates the exact
  // same payload (the determinism contract `buildModelMessages` relies
  // on). The model is fed only a truncated view below.
  const fullPayload: Record<string, unknown> = {
    ok: invoked.ok,
    status: invoked.ok ? "succeeded" : "failed",
    namespace,
    remote_tool: descriptor.name,
    content: invoked.content,
  };
  await updateToolCallOutput(db, toolCallId, fullPayload);
  await appendMessage(db, ctx.tenant_id, ctx.conversation_id, "tool", {
    tool: name,
    output: fullPayload,
  });

  // Truncated view for the model — reuse the canonical truncator so an
  // oversized remote payload can't blow subsequent context budgets. The
  // full payload stays on the tool-call row, reachable via get_raw_result.
  const truncated = truncateForLlm(fullPayload);
  const modelOutput = truncated.truncated
    ? {
        ...(truncated.data as Record<string, unknown>),
        _truncated: true,
        _raw_ref: truncated.raw_ref,
        _note: truncated.note,
      }
    : fullPayload;
  events.push({
    type: "tool_result",
    call_id: toolCallId,
    tool: name,
    output: modelOutput,
    parent_message_id: assistantMessageId,
  });
  recordConversationToolCall({
    category: "tenant_write",
    tool: name,
    outcome: invoked.ok ? "ok" : "error",
    duration_ms: Date.now() - startedAt,
  });
  return { ok: invoked.ok, data: modelOutput };
}
