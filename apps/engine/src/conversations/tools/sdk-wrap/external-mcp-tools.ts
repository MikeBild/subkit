// Synthetic `mcp_<ns>__<tool>` tools for the chat palette.
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
//   3. resolve approval through the ONE confirm gate (`tools/policy.ts`)
//      and the durable approval handle (`tools/approval.ts`) every other
//      surface uses — a pause persists the args, the confirmed re-issue
//      carries only the `confirm_id` and the engine replays them
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
import {
  getTenantMcpTools,
  invokeRemoteTool,
  type RemoteToolDescriptor,
} from "../../../mcp/client/pool.ts";
import { recordConversationToolCall } from "../../../observability/instrumentation.ts";
import { can } from "../../../rbac/evaluator.ts";
import {
  consumeApproval,
  recordApprovalApproved,
  requestApproval,
  stripConfirmMarkers,
} from "../../../tools/approval.ts";
import {
  confirmIdFromArgs,
  isConfirmedRequest,
  policyDecide,
  withConfirmMarkerProperties,
} from "../../../tools/policy.ts";
import { createElicitation } from "../../elicitations.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../../persist.ts";
import type { TurnEvent } from "../../types.ts";
import { withoutApprovalHandle } from "../ask-user/commit-intent.ts";
import type { ToolContext } from "../index.ts";
import { truncateForLlm } from "../truncate.ts";
import { jsonSafeModelOutput } from "./json-safe-output.ts";
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
  return tool<Record<string, unknown>, WrappedToolOutput, Record<string, unknown>>({
    // AI SDK 7: coerce tool output to JSON-safe for the model (see json-safe-output.ts).
    toModelOutput: jsonSafeModelOutput,
    description: `${descriptor.description} — external MCP tool (namespace ${p.namespace}). Asks for confirmation before running.`,
    // The remote server's schema plus the confirm markers — this tool always
    // pauses, so the model needs a declared slot to carry the `confirm_id`
    // back. The markers are stripped again before the args leave the perimeter.
    inputSchema: jsonSchema(
      withConfirmMarkerProperties(descriptor.inputSchema) as Parameters<typeof jsonSchema>[0],
    ),
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

  // Anchor an assistant message so this dispatch shows up in the same
  // persisted trail real tool calls produce.
  const ensureAnchor = async (): Promise<string> => {
    if (signals.assistantMessageId) return signals.assistantMessageId;
    const messageId = await appendMessage(db, ctx.tenant_id, ctx.conversation_id, "assistant", {});
    signals.assistantMessageId = messageId;
    return messageId;
  };
  const assistantMessageId = await ensureAnchor();

  // RBAC gate — members may invoke tools an admin already registered, but
  // a principal lacking `mcp_external_tool:invoke` is refused before any
  // outbound call leaves the tenant perimeter. The check runs BEFORE the
  // tool-call row is inserted so a denied principal's raw arguments
  // (possibly PII bound for a third-party server) are never persisted —
  // the denied row carries `{ denied: true }` as its input instead.
  const decision = await can(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission: "mcp_external_tool:invoke",
  });
  if (!decision.allow) {
    const deniedInput: Record<string, unknown> = { denied: true };
    const toolCallId = await insertToolCall(db, {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      parent_message_id: assistantMessageId,
      tool: name,
      input: deniedInput,
      approval_required: false,
    });
    events.push({
      type: "tool_call_start",
      call_id: toolCallId,
      tool: name,
      input_partial: deniedInput,
      parent_message_id: assistantMessageId,
    });
    events.push({
      type: "tool_call_end",
      call_id: toolCallId,
      input: deniedInput,
      parent_message_id: assistantMessageId,
    });
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

  // Claim the approval on a confirmed re-issue. The args it was granted for
  // are the REPLAY payload — whatever the model re-sent to satisfy the remote
  // tool's schema is discarded, so an approved call cannot be swapped for a
  // different one. Runs before the tool-call row so the persisted input is
  // the input that actually leaves the perimeter. The RBAC gate above already
  // ran; APPROVAL_APPROVED lands just before the outbound call.
  const confirmed = isConfirmedRequest(rawArgs, undefined);
  const claim = confirmed
    ? await consumeApproval({
        db,
        principal,
        approval_id: confirmIdFromArgs(rawArgs),
        tool: name,
        surface: "chat",
        via: "chat",
      })
    : null;
  const effectiveInput = claim?.ok ? claim.args : stripConfirmMarkers(rawArgs);

  // Tool-call row for the allowed dispatch. The full effective input is
  // persisted on purpose — the determinism contract (`buildModelMessages`
  // replay) rehydrates the exact input the remote tool received.
  const toolCallId = await insertToolCall(db, {
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    parent_message_id: assistantMessageId,
    tool: name,
    input: effectiveInput,
    approval_required: false,
  });
  events.push({
    type: "tool_call_start",
    call_id: toolCallId,
    tool: name,
    input_partial: effectiveInput,
    parent_message_id: assistantMessageId,
  });
  events.push({
    type: "tool_call_end",
    call_id: toolCallId,
    input: effectiveInput,
    parent_message_id: assistantMessageId,
  });

  if (claim && !claim.ok) {
    const output: Record<string, unknown> = {
      ok: false,
      status: "failed",
      error_code: claim.code,
      error: claim.message,
      namespace,
      remote_tool: descriptor.name,
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

  // The ONE confirm gate. `tool` stays the prefixed name so the policy
  // resolver's `mcp_` rule fires (forced confirm under auto/ask/plan);
  // `category: tenant_write` means a read never short-circuits it.
  // `not_available_on_surface` is unreachable here — the gate only withholds
  // `draft_write` on MCP.
  if (!claim) {
    const gate = policyDecide({
      tool: name,
      category: "tenant_write",
      surface: "chat",
      args: effectiveInput,
    });
    if (gate.kind === "needs_confirm") {
      // Same-turn single-pending-elicitation guard, mirroring the canonical
      // policy gate in `sdk-wrap/invoke.ts`. Parallel tool use is disabled at
      // the provider layer and the `toolChain` mutex serialises this turn, but
      // if a second write ever slipped through it must NOT supersede the first
      // pending approval — `createElicitation` cancels the prior pending row,
      // which would orphan its still-unclaimed approval handle. Refuse before
      // minting a second approval.
      if (signals.pendingElicitation) {
        const dupOutput: Record<string, unknown> = {
          ok: false,
          status: "failed",
          error_code: "duplicate_pending_elicitation_in_turn",
          error: `Another tool call in this turn already staged an ask_user_confirm (${signals.pendingElicitation.tool_name}). Wait for the operator to resolve it, then re-issue ${name}.`,
          namespace,
          remote_tool: descriptor.name,
        };
        await updateToolCallOutput(db, toolCallId, dupOutput);
        events.push({
          type: "tool_result",
          call_id: toolCallId,
          tool: name,
          output: dupOutput,
          parent_message_id: assistantMessageId,
        });
        recordConversationToolCall({
          category: "tenant_write",
          tool: name,
          outcome: "denied",
          duration_ms: Date.now() - startedAt,
        });
        return { ok: false, data: dupOutput };
      }
      // `confirm_id` IS the approval id: the model re-issues carrying it as the
      // `__policy_confirm_id` trigger, and `executeExternalMcpTool`'s
      // `consumeApproval` above claims exactly this row. Minting the approval
      // UNGRANTED is only half the gate — a remote MCP call cannot be performed
      // from a harness resume, so the model must re-issue it, and
      // `consumeApproval` demands `granted_at`. The MISSING half is the human
      // GRANT, which the ask_user_confirm below raises: when a HUMAN answers it,
      // the harness grants THIS id and stops (`auto-persist.ts` →
      // `grant_relayed_tool_call`); a model re-issue alone reaches an ungranted
      // row and proceeds nowhere.
      const confirm_id = gate.envelope.tool_call_id;
      const requested = await requestApproval({
        db,
        principal,
        approval_id: confirm_id,
        tool: name,
        surface: "chat",
        via: "chat",
        reason: gate.envelope.reason,
        // A remote MCP server has no dev/prod environment of ours to bind.
        execution_mode: null,
        args: effectiveInput,
      });
      // Field NAMES only, mirroring run_workflow's `input_keys`. NEVER the
      // values — external tool args are bound for a third-party server and may
      // carry sensitive data, so neither the elicitation nor the pending
      // envelope may echo them. Sorted so the shape is deterministic.
      const inputKeys = Object.keys(effectiveInput).sort();
      // The ask_user_confirm a HUMAN answers. Its commit_intent is the
      // GRANT-ONLY carrier `grant_relayed_tool_call`: the harness grants the
      // approval on a human answer and never performs the remote call itself.
      // The handle rides on the persisted row the harness reads; every
      // client-facing projection strips it via `withoutApprovalHandle`.
      const elicitationInput: Record<string, unknown> = {
        kind: "external_write",
        question: `Policy requires confirmation before running the external MCP tool ${name} (server ${namespace}). Proceed?`,
        target: { tool: name, namespace, remote_tool: descriptor.name },
        pending_output: { namespace, remote_tool: descriptor.name, input_keys: inputKeys },
        commit_intent: {
          kind: "grant_relayed_tool_call",
          payload: { tool: name, approval_id: confirm_id },
          description: `Approve the external MCP tool ${name} so it can run.`,
        },
        // Persist the human-reachable link, not just mention it to the model.
        // Withholding it here left the operator with no channel at all on a
        // client that cannot render a form, and left the portal's completion
        // bridge unable to recognise the row.
        ...(requested.approval_url ? { approval_url: requested.approval_url } : {}),
      };
      const elicitationSummary = `Run external MCP tool ${name} (server ${namespace})`;
      const elicitation = await createElicitation(
        {
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          tool_call_id: toolCallId,
          parent_message_id: assistantMessageId,
          tool_name: "ask_user_confirm",
          summary: elicitationSummary,
          input: elicitationInput,
          actor_id: ctx.actor_id,
        },
        db,
      );
      signals.pendingChildElicitationIds.push(elicitation.id);
      // The approval handle stays on the persisted row; the model and every
      // client see the prompt minus the capability.
      const operatorInput = withoutApprovalHandle(elicitationInput);
      const pendingOutput = { namespace, remote_tool: descriptor.name, input_keys: inputKeys };
      // The model-facing tool result. `confirm_id` is the re-issue TRIGGER, not
      // a gate — the claim still requires the human grant — so it is safe to
      // show; `approval_url` is a human-only link the model cannot click. The
      // `approval_id` handle itself is never shown.
      const output: Record<string, unknown> = {
        pending: true,
        status: "awaiting_confirmation",
        policy_mode: "confirm_before_execution",
        confirm_required: true,
        confirm_id,
        elicitation_id: elicitation.id,
        note: `Nothing ran. The operator must approve ${name} before it runs — they will see a confirmation in chat${
          requested.approval_url ? ` (or open ${requested.approval_url})` : ""
        }. After they approve, re-issue ${name} with __policy_confirmed: true and __policy_confirm_id: "${confirm_id}" to perform it — the engine replays the arguments it already holds. You cannot approve on their behalf.`,
        namespace,
        remote_tool: descriptor.name,
        pending_output: pendingOutput,
      };
      await updateToolCallOutput(db, toolCallId, output);
      events.push({
        type: "tool_result",
        call_id: toolCallId,
        tool: name,
        output,
        parent_message_id: assistantMessageId,
      });
      events.push({
        type: "elicit_request",
        elicitation_id: elicitation.id,
        tool_call_id: toolCallId,
        tool_name: "ask_user_confirm",
        summary: elicitation.summary,
        input: operatorInput,
        parent_message_id: assistantMessageId,
        pending_output: pendingOutput,
      });
      signals.pendingElicitation = {
        elicitation_id: elicitation.id,
        tool_name: "ask_user_confirm",
        kind: "external_write",
        summary: elicitationSummary,
        input: operatorInput,
      };
      recordConversationToolCall({
        category: "tenant_write",
        tool: name,
        outcome: "pending",
        duration_ms: Date.now() - startedAt,
      });
      // A top-level `pause` key is what `pausedStopCondition` (loop stopWhen)
      // detects to halt the stream — the turn ends in `awaiting_confirmation`
      // instead of the model barrelling ahead into a re-issue nobody granted.
      return {
        ok: false,
        data: output,
        pause: {
          tool_name: "ask_user_confirm",
          kind: "external_write",
          summary: elicitationSummary,
          elicitation_id: elicitation.id,
          input: operatorInput,
        },
      };
    }
    // Enforce the gate locally, do not trust an out-of-module invariant. An
    // unconfirmed external MCP call MUST resolve to `needs_confirm`: the tool
    // is `tenant_write` and this call passes no `permission_mode`, so
    // `decideToolMode` yields `confirm_before_execution` today. If a future
    // change ever downgrades that (a per-tool override, a threaded
    // `permission_mode:"auto"`), the fall-through below would dispatch a remote
    // write with no approval row and no APPROVAL_APPROVED. Refuse instead of
    // trusting the mode two modules away.
    const output: Record<string, unknown> = {
      ok: false,
      status: "failed",
      error_code: "unexpected_gate_decision",
      error: `Policy returned ${gate.kind} for an unconfirmed ${name}; a remote write must pause for human approval. Nothing was invoked.`,
      namespace,
      remote_tool: descriptor.name,
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
      outcome: "error",
      duration_ms: Date.now() - startedAt,
    });
    logger.warn({
      module: "conversation_tool",
      action: "external_mcp.unexpected_gate_decision",
      msg: "unconfirmed external MCP tool did not resolve to needs_confirm — refused rather than dispatched unaudited",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool: name,
      gate_kind: gate.kind,
    });
    return { ok: false, data: output };
  }

  // Authorized and confirmed: record the approval before the payload leaves the
  // tenant perimeter. A write we cannot audit is a write we do not perform.
  if (claim?.ok) {
    const recorded = await recordApprovalApproved({
      db,
      principal,
      claim,
      tool: name,
      via: "chat",
    });
    if (!recorded) {
      const output: Record<string, unknown> = {
        ok: false,
        status: "failed",
        error_code: "approval_audit_failed",
        error: `Confirmation ${claim.approval_id} could not be recorded in the audit log; ${name} was not invoked. Re-issue ${name} to obtain a fresh confirmation.`,
        namespace,
        remote_tool: descriptor.name,
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
        outcome: "error",
        duration_ms: Date.now() - startedAt,
      });
      return { ok: false, data: output };
    }
  }

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
    input: effectiveInput,
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
