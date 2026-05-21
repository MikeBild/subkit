// Resolve a pending `ask_user_*` elicitation with the operator's
// answer and resume the conversation loop. Owns the
// confirmation-state-machine mirror, the auto-persist hook, and the
// committed-conversation short-circuit.

import { and, desc, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { log } from "../../logging/logger.ts";
import type { ElicitationBridge } from "../../mcp/elicitation/bridge.ts";
import { runLoop } from "../loop.ts";
import type { ConversationPermissionMode } from "../types.ts";
import { getConversation } from "./get.ts";
import {
  type ConversationTurnOutcome,
  ElicitationAlreadyResolvedError,
  getStoredPermissionMode,
  isAskUserToolName,
  normalizePermissionMode,
  persistPermissionModeIfChanged,
} from "./shared.ts";

export interface RespondElicitationParams {
  tenant_id: string;
  conversation_id: string;
  elicitation_id: string;
  actor_id: string | null;
  /** User's answer — shape depends on the tool (choice/multi/text/form/confirm). */
  output: unknown;
  reason?: string;
  permission_mode?: ConversationPermissionMode | null;
  /**
   * Live event emitter. When the route is in SSE mode this fires for
   * every TurnEvent the resumed runLoop produces, so the CLI sees
   * real-time progress instead of a 1–2 minute spinner before the
   * buffered JSON outcome arrives. Pre-fix the respond endpoint was
   * JSON-only — the operator saw `summarising 28 tool results · 1m43s
   * · 370886t` for the entire turn before any text or tool card
   * rendered.
   */
  onEvent?: Parameters<typeof runLoop>[0]["onEvent"];
  /** Pre-registered AbortController — see RunLoopParams.turn_abort_ctrl.
   *  Required: the HTTP route handler / MCP tool path registers on
   *  the synchronous frame of request-accept and threads through. */
  turn_abort_ctrl: AbortController;
  /**
   * MCP-native elicitation bridge — present only when the resume runs
   * inside an MCP `tools/call` whose client advertised the
   * `elicitation` capability. Threaded onto the resumed loop's
   * `ToolContext`.
   */
  elicitationBridge?: ElicitationBridge;
}

/**
 * Resolve an `askUser.*` elicitation with the user's answer and
 * resume the conversation loop. This is the only pause-resume path —
 * the legacy approval flow has been removed.
 */
export async function respondElicitation(
  p: RespondElicitationParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  const { resolveElicitation } = await import("../elicitations.ts");
  const resolveOutcome = await resolveElicitation(
    {
      tenant_id: p.tenant_id,
      id: p.elicitation_id,
      output: p.output,
      decided_by: p.actor_id,
      ...(p.reason ? { reason: p.reason } : {}),
    },
    exec,
  );
  if (resolveOutcome.kind === "not_found") throw new Error("elicitation not found");
  if (resolveOutcome.kind === "already_resolved") {
    const status =
      resolveOutcome.existing.status === "pending" ? "resolved" : resolveOutcome.existing.status;
    throw new ElicitationAlreadyResolvedError({
      elicitation_id: p.elicitation_id,
      status: status as "resolved" | "cancelled" | "timeout",
      previous_output: resolveOutcome.existing.output,
      previous_decision_reason: resolveOutcome.existing.decision_reason,
    });
  }
  const resolved = resolveOutcome.record;

  let originatingToolCall: {
    id: string;
    tool: string;
  } | null = null;
  if (resolved.tool_call_id) {
    const [toolCall] = await exec
      .select({
        id: conversationToolCalls.id,
        tool: conversationToolCalls.tool,
      })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.id, resolved.tool_call_id),
          eq(conversationToolCalls.tenant_id, p.tenant_id),
        ),
      )
      .limit(1);
    originatingToolCall = toolCall ?? null;
  } else if (isAskUserToolName(resolved.tool_name)) {
    // Legacy ask_user_* rows were created without a tool_call_id. We
    // infer the latest matching call so already-open dialogs can still
    // resume correctly after the fix ships.
    const [toolCall] = await exec
      .select({
        id: conversationToolCalls.id,
        tool: conversationToolCalls.tool,
      })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, p.tenant_id),
          eq(conversationToolCalls.conversation_id, p.conversation_id),
          eq(conversationToolCalls.tool, resolved.tool_name),
        ),
      )
      .orderBy(desc(conversationToolCalls.created_at))
      .limit(1);
    originatingToolCall = toolCall ?? null;
  }

  // Mirror the response to the interaction_log on the originating tool
  // call. The confirmation state machine (see conversations/confirmation.ts)
  // tracks user_confirmed / user_declined / user_partial / user_tested so
  // the LLM can reason about what the operator actually said in the next
  // turn instead of reading only the raw output payload.
  if (originatingToolCall) {
    const { recordTransition } = await import("../confirmation.ts");
    const out = (p.output ?? {}) as Record<string, unknown>;
    let to_state: "confirmed" | "declined" | "partial" | "tested" = "confirmed";
    if (out.tested === true) to_state = "tested";
    else if (out.partial === true) to_state = "partial";
    else if (out.confirmed === false || out.declined === true) to_state = "declined";
    else if (out.confirmed === true) to_state = "confirmed";
    await recordTransition(exec, {
      tool_call_id: originatingToolCall.id,
      tenant_id: p.tenant_id,
      to_state,
      tool: originatingToolCall.tool,
      ...(p.actor_id ? { actor_id: p.actor_id } : {}),
      ...(isAskUserToolName(originatingToolCall.tool)
        ? {}
        : { conversation_id: p.conversation_id }),
      data: { elicitation_id: p.elicitation_id },
    });
  }

  log.conversation.approval.approved({
    conversation_id: p.conversation_id,
    approval_id: p.elicitation_id,
    actor_id: p.actor_id,
  });

  await exec
    .update(conversations)
    .set({ status: "active", updated_at: new Date() })
    .where(eq(conversations.id, p.conversation_id));

  // Auto-persist hook (PR11/PR12) — when the resolved elicitation
  // carries a `commit_intent`, the harness applies the intended write
  // atomically BEFORE the next LLM turn. The dispatcher emits a
  // synthetic tool-call + tool-result the runLoop's
  // buildModelMessages will replay so the LLM sees the persistence as
  // a normal tool result with `source: "harness_auto_persist"`.
  // Decline path injects a synthetic decline result so the next turn
  // carries the signal without firing the actual write. The
  // credential-cache + auto-persist sequence is factored into
  // `applyElicitationOutcome` so the MCP-native in-process bridge path
  // (ask-user/common.ts) runs the exact same logic.
  const { applyElicitationOutcome } = await import("../persistence/apply-outcome.ts");
  const autoPersist = await applyElicitationOutcome({
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    output: p.output,
    elicitation: {
      id: resolved.id,
      tool_name: resolved.tool_name,
      input: resolved.input,
    },
    db: exec,
  });

  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");
  const explicitPermissionMode = normalizePermissionMode(p.permission_mode);
  const storedPermissionMode = getStoredPermissionMode(conv.draft);
  const effectivePermissionMode = explicitPermissionMode ?? storedPermissionMode;
  if (explicitPermissionMode && explicitPermissionMode !== storedPermissionMode) {
    await persistPermissionModeIfChanged({
      exec,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      draft: conv.draft,
      permission_mode: explicitPermissionMode,
    });
  }
  if (
    autoPersist.dispatched &&
    conv.conversation.status === "committed" &&
    conv.conversation.target_workflow_id
  ) {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONVERSATION_COMMITTED,
        resource_type: "conversation",
        resource_id: p.conversation_id,
        result: "success",
        metadata: { workflow_id: conv.conversation.target_workflow_id },
      },
      exec,
    );
    return {
      conversation: conv.conversation,
      result: {
        events: [{ type: "committed", workflow_id: conv.conversation.target_workflow_id }],
        status: "committed",
        committed_workflow_id: conv.conversation.target_workflow_id,
      },
    };
  }

  const result = await runLoop({
    db: exec,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    connector_id: conv.conversation.target_connector_id,
    workflow_id: conv.conversation.target_workflow_id,
    user_message: null,
    turn_abort_ctrl: p.turn_abort_ctrl,
    ...(effectivePermissionMode ? { permission_mode: effectivePermissionMode } : {}),
    ...(p.onEvent ? { onEvent: p.onEvent } : {}),
    ...(p.elicitationBridge ? { elicitationBridge: p.elicitationBridge } : {}),
  });
  const updated = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!updated) throw new Error("conversation disappeared");
  if (result.status === "committed" && result.committed_workflow_id) {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONVERSATION_COMMITTED,
        resource_type: "conversation",
        resource_id: p.conversation_id,
        result: "success",
        metadata: { workflow_id: result.committed_workflow_id },
      },
      exec,
    );
  }
  return { conversation: updated.conversation, result };
}
