import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { resolveActor } from "../../audit/recorders/types.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { withTenantWork } from "../../execution/tenant-work.ts";
import { askBeforeWritingFor } from "../../identity/index.ts";
import { assertTenantActive } from "../../identity/tenant-status.ts";
import { scrubString } from "../../logging/scrub-secrets.ts";
import { recordConversationToolCall } from "../../observability/instrumentation.ts";
import { withRawResultScope } from "../../tools/truncate.ts";
import type { AnswerActor } from "../answer-actor.ts";
import type { ElicitationBridge } from "../elicitation-bridge.ts";
import { elicitationRefusalOutput } from "../elicitation-refusal.ts";
import { createElicitation } from "../elicitations.ts";
import { tryFastPath } from "../fast-path.ts";
import { type RunLoopResult, runLoop } from "../loop/index.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../persistence/index.ts";
import type { ConversationReference } from "../references.ts";
import { refreshConversationTitle, shouldRefreshTitle } from "../title.ts";
import { conversationTurnId, markConversationTurnFailed } from "../turns.ts";
import type { TaskRunMarker, TurnEvent } from "../types.ts";
import { getConversation } from "./get.ts";
import type { ConversationTurnOutcome } from "./shared.ts";
import {
  assertConversationWriter,
  requireTaskRunPrincipal,
  TaskRunLockedError,
} from "./task-run-access.ts";

export interface RequestCredentialFormEvent {
  type: "request_credential_form";
  credential_hint?: string | undefined;
}

export interface RunConversationTurnParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  write_via?: "chat_thread";
  locale?: "de" | "en";
  user_message: string;
  answer_actor: AnswerActor;
  user_references?: ConversationReference[] | null;
  user_memory?: string | null;
  onEvent?: Parameters<typeof runLoop>[0]["onEvent"];
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
  };
  turn_abort_ctrl: AbortController;
  next_suggestion_suppress?: boolean;
  elicitationBridge?: ElicitationBridge;
  event?: RequestCredentialFormEvent;
  principal?: ResolvedPrincipal | null;
}

export async function runConversationTurn(
  p: RunConversationTurnParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  return withRawResultScope(
    {
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      actor_id: p.principal?.id ?? p.actor_id,
    },
    () =>
      withTenantWork(p.tenant_id, async () => {
        await assertTenantActive(p.tenant_id, exec);
        const turn_id = conversationTurnId(p.turn_abort_ctrl);
        const onEvent = p.onEvent;
        const scoped = {
          ...p,
          ...(onEvent
            ? {
                onEvent: (event: TurnEvent) =>
                  onEvent({ ...event, ...{ conversation_id: p.conversation_id, turn_id } }),
              }
            : {}),
        };
        const outcome = await driveConversationTurn(scoped, exec).catch((error: unknown) => {
          markConversationTurnFailed(p.turn_abort_ctrl);
          throw error;
        });
        return { ...outcome, ...(turn_id ? { turn_id } : {}) };
      }),
  );
}

async function driveConversationTurn(
  p: RunConversationTurnParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  const conv = await getConversation(
    p.tenant_id,
    p.conversation_id,
    exec,
    p.principal ?? undefined,
    p.locale,
  );
  if (!conv) throw new Error("conversation not found");
  const taskRun = await assertConversationWriter(exec, p);
  if (taskRun) return driveTaskRunTurn(p, exec, conv, taskRun);
  const askBeforeWriting = await askBeforeWritingFor(exec, {
    tenant_id: p.tenant_id,
    principal: p.principal,
  });

  if (p.event?.type === "request_credential_form") {
    const result = await runRequestCredentialFormEvent(p, exec);
    if (p.onEvent) {
      for (const ev of result.events) p.onEvent(ev);
    }
    const updated = await getConversation(
      p.tenant_id,
      p.conversation_id,
      exec,
      p.principal ?? undefined,
      p.locale,
    );
    if (!updated) throw new Error("conversation disappeared");
    return { conversation: updated.conversation, result };
  }

  if (p.principal && p.user_message) {
    const hit = await tryFastPath({
      db: exec,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      actor_id: p.actor_id,
      principal: p.principal,
      user_message: p.user_message,
      answer_actor: p.answer_actor,
      ask_before_writing: askBeforeWriting,
      ...(p.surface ? { surface: p.surface } : {}),
    });
    if (hit) {
      if (p.onEvent) {
        for (const ev of hit.events) p.onEvent(ev);
      }
      const fastResult: RunLoopResult = {
        events: hit.events,
        status: hit.status,
        ...(hit.pending_elicitation_id
          ? { pending_elicitation_id: hit.pending_elicitation_id }
          : {}),
      };
      const updated = await getConversation(
        p.tenant_id,
        p.conversation_id,
        exec,
        p.principal ?? undefined,
        p.locale,
      );
      if (!updated) throw new Error("conversation disappeared");
      return { conversation: updated.conversation, result: fastResult };
    }
  }

  return finishLoopTurn(p, exec, conv, askBeforeWriting);
}

type LoadedConversation = NonNullable<Awaited<ReturnType<typeof getConversation>>>;

async function driveTaskRunTurn(
  p: RunConversationTurnParams,
  exec: Db,
  conv: LoadedConversation,
  taskRun: TaskRunMarker,
): Promise<ConversationTurnOutcome> {
  if (p.event) throw new TaskRunLockedError("Collecting a credential");
  const principal = requireTaskRunPrincipal(p.principal, taskRun);
  const askBeforeWriting = await askBeforeWritingFor(exec, {
    tenant_id: p.tenant_id,
    principal,
  });
  return finishLoopTurn({ ...p, principal }, exec, conv, askBeforeWriting);
}

async function finishLoopTurn(
  p: RunConversationTurnParams,
  exec: Db,
  conv: LoadedConversation,
  askBeforeWriting: boolean,
): Promise<ConversationTurnOutcome> {
  const result = await runLoop({
    db: exec,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    ...(p.principal ? { principal: p.principal } : {}),
    ...(p.locale ? { locale: p.locale } : {}),
    connector_id: conv.conversation.target_connector_id,
    workflow_id: conv.conversation.target_workflow_id,
    user_message: p.user_message,
    user_message_persisted: true,
    ...(p.user_references && p.user_references.length > 0
      ? { user_references: p.user_references }
      : {}),
    user_memory: p.user_memory ?? null,
    model_override: conv.conversation.model,
    turn_abort_ctrl: p.turn_abort_ctrl,
    ...(p.surface ? { surface: p.surface } : {}),
    ...(p.onEvent ? { onEvent: p.onEvent } : {}),
    ...(p.runtime_context ? { runtime_context: p.runtime_context } : {}),
    ...(askBeforeWriting ? { ask_before_writing: true } : {}),
    ...(p.next_suggestion_suppress !== undefined
      ? { next_suggestion_suppress: p.next_suggestion_suppress }
      : {}),
    ...(p.elicitationBridge ? { elicitationBridge: p.elicitationBridge } : {}),
  });

  const updated = await getConversation(
    p.tenant_id,
    p.conversation_id,
    exec,
    p.principal ?? undefined,
    p.locale,
  );
  if (!updated) throw new Error("conversation disappeared");

  const [turnRow] = await exec
    .select({ turn_count: conversations.turn_count, title_locked: conversations.title_locked })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .limit(1);
  if (turnRow && shouldRefreshTitle(turnRow.turn_count, turnRow.title_locked)) {
    void refreshConversationTitle(p.tenant_id, p.conversation_id, exec);
  }

  if (result.status === "committed" && result.committed_workflow_id) {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        ...resolveActor({
          tenant_id: p.tenant_id,
          actor_id: p.principal?.id ?? p.actor_id,
          actor_type: p.principal?.kind ?? (p.actor_id === null ? "system" : "unknown"),
        }),
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

async function runRequestCredentialFormEvent(
  p: RunConversationTurnParams,
  exec: Db,
): Promise<RunLoopResult> {
  const hint = p.event?.credential_hint ? scrubString(p.event.credential_hint).trim() : "";
  const label = hint.length > 0 ? hint.replace(/_/g, " ") : "credential";
  const question = `Please enter the ${label}. The value is collected through a masked field and never echoed into the chat transcript.`;
  const formInput = {
    question,
    fields: [
      {
        name: "credential",
        label,
        type: "password" as const,
        required: true,
        sensitive: true,
      },
    ],
  };
  const assistantText = `I need the ${label} from you — please fill in the masked form below. Never paste secrets directly into the chat.`;
  const assistantMessageId = await appendMessage(
    exec,
    p.tenant_id,
    p.conversation_id,
    "assistant",
    { text: assistantText, fast_path: true },
  );
  const toolCallId = await insertToolCall(exec, {
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    parent_message_id: assistantMessageId,
    tool: "ask_user_form",
    input: formInput,
    approval_required: false,
  });
  const opening = await createElicitation(
    {
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      tool_call_id: toolCallId,
      parent_message_id: assistantMessageId,
      tool_name: "ask_user_form",
      summary: question,
      input: formInput,
      actor_id: p.actor_id,
      actor_type: p.principal?.kind ?? (p.actor_id === null ? "system" : "unknown"),
    },
    exec,
  );
  if (!opening.ok) {
    const refused = elicitationRefusalOutput(opening.reason);
    await updateToolCallOutput(exec, toolCallId, refused, "denied");
    return {
      events: [
        { type: "message", role: "assistant", content: assistantText, id: assistantMessageId },
        {
          type: "tool_result",
          call_id: toolCallId,
          tool: "ask_user_form",
          output: refused,
          parent_message_id: assistantMessageId,
        },
        { type: "completed", status: "abandoned" },
      ],
      status: "abandoned",
    };
  }
  const elicitation = opening.elicitation;
  await updateToolCallOutput(
    exec,
    toolCallId,
    { status: "awaiting_input", elicitation_id: elicitation.id },
    "pending",
  );
  recordConversationToolCall({
    category: "draft_write",
    tool: "ask_user_form",
    outcome: "pending",
    duration_ms: 0,
  });
  const events: TurnEvent[] = [
    {
      type: "message",
      role: "assistant",
      content: assistantText,
      id: assistantMessageId,
    },
    {
      type: "tool_call_start",
      call_id: toolCallId,
      tool: "ask_user_form",
      input_partial: formInput,
      parent_message_id: assistantMessageId,
    },
    {
      type: "tool_call_end",
      call_id: toolCallId,
      input: formInput,
      parent_message_id: assistantMessageId,
    },
    {
      type: "elicit_request",
      elicitation_id: elicitation.id,
      tool_call_id: toolCallId,
      tool_name: "ask_user_form",
      summary: question,
      input: formInput,
      parent_message_id: assistantMessageId,
    },
    { type: "completed", status: "awaiting_input" },
  ];
  return {
    events,
    status: "awaiting_input",
    pending_elicitation_id: elicitation.id,
  };
}
