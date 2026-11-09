import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { conversations, conversationToolCalls, users } from "../../db/schema/index.ts";
import { log } from "../../logging/logger.ts";
import type { AnswerActor } from "../answer-actor.ts";
import { decidedByAuditActor, decidedByFor } from "../decided-by.ts";
import type { ElicitationBridge } from "../elicitation-bridge.ts";
import {
  ElicitationActorMismatchError,
  ElicitationAnswerActorUnavailableError,
  ElicitationNotFoundError,
  ElicitationValidationError,
} from "../errors.ts";
import { runLoop } from "../loop/index.ts";
import { applyElicitationOutcome } from "../persistence/apply-outcome.ts";
import { isProseQuestionElicitation } from "../prose-question-answer.ts";
import {
  interpretConfirmDecision,
  normalizeConfirmOutput,
} from "../tools/ask-user/interpret-confirm.ts";
import { conversationTurnId, markConversationTurnFailed } from "../turns.ts";
import type { ConversationPermissionMode } from "../types.ts";
import { getConversation } from "./get.ts";
import {
  ConversationNotFoundError,
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
  principal?: ResolvedPrincipal | null;
  answer_actor: AnswerActor;
  output: unknown;
  reason?: string;
  resolution_status?: "resolved" | "cancelled";
  permission_mode?: ConversationPermissionMode | null;
  require_same_actor?: boolean;
  onEvent?: Parameters<typeof runLoop>[0]["onEvent"];
  turn_abort_ctrl: AbortController;
  elicitationBridge?: ElicitationBridge;
  surface?: Parameters<typeof runLoop>[0]["surface"];
  locale?: "de" | "en";
}

export { ConversationNotFoundError } from "./shared.ts";

function mergeFieldErrorsIntoInput(
  tool_name: string,
  input: unknown,
  field_errors: Array<{ name: string; message: string }>,
): unknown {
  if (tool_name !== "ask_user_form" || !input || typeof input !== "object") return input;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.fields)) return input;
  const byName = new Map(field_errors.map((e) => [e.name, e.message]));
  return {
    ...obj,
    fields: obj.fields.map((f) => {
      if (!f || typeof f !== "object") return f;
      const field = f as Record<string, unknown>;
      const message = typeof field.name === "string" ? byName.get(field.name) : undefined;
      return message ? { ...field, error_message: message } : field;
    }),
  };
}

export async function respondElicitation(
  p: RespondElicitationParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  const turn_id = conversationTurnId(p.turn_abort_ctrl);
  const onEvent = p.onEvent;
  const scoped = {
    ...p,
    ...(onEvent
      ? {
          onEvent: (event: import("../types.ts").TurnEvent) =>
            onEvent({ ...event, ...{ conversation_id: p.conversation_id, turn_id } }),
        }
      : {}),
  };
  const outcome = await driveElicitation(scoped, exec).catch((error: unknown) => {
    markConversationTurnFailed(p.turn_abort_ctrl);
    throw error;
  });
  return { ...outcome, ...(turn_id ? { turn_id } : {}) };
}

async function driveElicitation(
  p: RespondElicitationParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  if (p.require_same_actor) {
    const detail = await getConversation(p.tenant_id, p.conversation_id, exec);
    if (!detail) throw new ConversationNotFoundError(p.conversation_id);
    if (detail.conversation.owner_id !== p.actor_id) {
      throw new ElicitationActorMismatchError(p.conversation_id, p.actor_id);
    }
  }

  const { getElicitation, resolveElicitation } = await import("../elicitations.ts");
  const pendingRow = await getElicitation(p.tenant_id, p.elicitation_id, exec);
  if (!pendingRow || pendingRow.conversation_id !== p.conversation_id)
    throw new ElicitationNotFoundError(p.elicitation_id);
  if (p.answer_actor.kind === "human" && p.answer_actor.via === "portal") {
    const [answerUser] = await exec
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, p.answer_actor.user_id),
          eq(users.tenant_id, p.tenant_id),
          eq(users.status, "active"),
          isNull(users.deleted_at),
        ),
      )
      .limit(1);
    if (!answerUser) throw new ElicitationAnswerActorUnavailableError(p.answer_actor.user_id);
  }
  const output =
    pendingRow?.tool_name === "ask_user_confirm" ? normalizeConfirmOutput(p.output) : p.output;
  if (pendingRow && pendingRow.status === "pending") {
    const { validateElicitationAnswer } = await import("../tools/ask-user/validate-answer.ts");
    const verdict = validateElicitationAnswer(pendingRow.tool_name, pendingRow.input, output);
    if (!verdict.ok) {
      throw new ElicitationValidationError(p.elicitation_id, verdict.field_errors, {
        id: pendingRow.id,
        tool_name: pendingRow.tool_name,
        summary: pendingRow.summary,
        input: mergeFieldErrorsIntoInput(
          pendingRow.tool_name,
          pendingRow.input,
          verdict.field_errors,
        ),
      });
    }
  }
  const decided_by = decidedByFor(p.actor_id, p.tenant_id, p.principal, p.answer_actor);
  const resolveOutcome = await resolveElicitation(
    {
      tenant_id: p.tenant_id,
      id: p.elicitation_id,
      output,
      decided_by,
      ...(p.resolution_status ? { status: p.resolution_status } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
    },
    exec,
  );
  if (resolveOutcome.kind === "not_found") throw new ElicitationNotFoundError(p.elicitation_id);
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
  } else if (isAskUserToolName(resolved.tool_name) && !isProseQuestionElicitation(resolved)) {
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

  if (originatingToolCall) {
    const { recordTransition } = await import("../confirmation.ts");
    const out = (output ?? {}) as Record<string, unknown>;
    let to_state: "confirmed" | "declined" | "partial" | "tested" = "confirmed";
    if (out.tested === true) to_state = "tested";
    else if (out.partial === true) to_state = "partial";
    else if (interpretConfirmDecision(out) === "declined") to_state = "declined";
    else to_state = "confirmed";
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

  const decisionLog = {
    conversation_id: p.conversation_id,
    approval_id: p.elicitation_id,
    actor_id: p.actor_id,
  };
  if (resolved.status === "resolved" && interpretConfirmDecision(output) !== "declined") {
    log.conversation.approval.approved(decisionLog);
  } else {
    log.conversation.approval.rejected({ ...decisionLog, reason: p.reason });
  }

  await exec
    .update(conversations)
    .set({ status: "active", updated_at: new Date() })
    .where(eq(conversations.id, p.conversation_id));

  const autoPersist = await applyElicitationOutcome({
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    answer_actor: p.answer_actor,
    ...(p.principal !== undefined ? { principal: p.principal } : {}),
    ...(p.surface ? { surface: p.surface } : {}),
    output,
    elicitation: {
      id: resolved.id,
      tool_name: resolved.tool_name,
      input: resolved.input,
      tool_call_id: resolved.tool_call_id,
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
  const savedDraft = z
    .object({
      workflow_id: z.string(),
      workflow_version_id: z.string(),
      persistence_kind: z.literal("draft"),
      activation_required: z.literal(true),
    })
    .safeParse(autoPersist.synthetic_result?.data);
  if (
    autoPersist.dispatched &&
    autoPersist.synthetic_result?.ok &&
    autoPersist.synthetic_result.tool === "save_workflow_draft" &&
    savedDraft.success &&
    conv.conversation.target_workflow_id === savedDraft.data.workflow_id &&
    conv.draft?.state?.persisted_resources.some(
      (resource) =>
        resource.kind === "workflow" &&
        resource.id === savedDraft.data.workflow_id &&
        resource.version_id === savedDraft.data.workflow_version_id &&
        resource.persistence_kind === "draft",
    )
  ) {
    return {
      conversation: conv.conversation,
      result: {
        events: [{ type: "committed", workflow_id: savedDraft.data.workflow_id }],
        status: "active",
        committed_workflow_id: savedDraft.data.workflow_id,
      },
    };
  }
  if (
    autoPersist.dispatched &&
    conv.conversation.status === "committed" &&
    conv.conversation.target_workflow_id
  ) {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        ...decidedByAuditActor(decided_by),
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
    ...(p.principal ? { principal: p.principal } : {}),
    connector_id: conv.conversation.target_connector_id,
    workflow_id: conv.conversation.target_workflow_id,
    user_message: null,
    turn_abort_ctrl: p.turn_abort_ctrl,
    ...(p.surface ? { surface: p.surface } : {}),
    ...(p.locale ? { locale: p.locale } : {}),
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
        ...decidedByAuditActor(decided_by),
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

export {
  ElicitationActorMismatchError,
  ElicitationAnswerActorUnavailableError,
  ElicitationNotFoundError,
  ElicitationValidationError,
} from "../errors.ts";
