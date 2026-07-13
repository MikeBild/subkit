// The `runLoop` tail of a conversation turn, extracted so it can run in
// two places without code duplication:
//
//   1. Inline, right after `createConversation` / `appendUserMessage`
//      on the HTTP+SSE surface — the streaming `onEvent` is threaded
//      straight through, so that surface does not regress.
//   2. Inside the `conversation.run-turn` pg-boss worker for the MCP
//      async-Tasks path, where the `tools/call` returned long ago.
//
// `createConversation` / `appendUserMessage` own row insert + audit +
// validation + the `conversation_messages` user-row insert. This
// function owns ONLY the model loop + the terminal reload + the
// `CONVERSATION_COMMITTED` audit on a committed turn.

import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { scrubString } from "../../logging/scrub-secrets.ts";
import { recordConversationToolCall } from "../../observability/instrumentation.ts";
import type { AnswerActor } from "../answer-actor.ts";
import type { ElicitationBridge } from "../elicitation-bridge.ts";
import { createElicitation } from "../elicitations.ts";
import { tryFastPath } from "../fast-path.ts";
import { type RunLoopResult, runLoop } from "../loop.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../persist.ts";
import type { ConversationPermissionMode, TurnEvent } from "../types.ts";
import { getConversation } from "./get.ts";
import { type ConversationTurnOutcome, getStoredPermissionMode } from "./shared.ts";

/**
 * Typed client event carried on POST /v1/conversations/{id}/messages.
 * Single-variant union for now — widen to a discriminated union when a
 * second event type lands (the Zod wire schema in
 * `http/routes/conversations/schemas.ts` mirrors this shape).
 *
 * `credential_hint` is a short, client-detected credential KIND label
 * (e.g. "digitalocean_pat") used only to title the masked form field —
 * NEVER the secret itself.
 */
export interface RequestCredentialFormEvent {
  type: "request_credential_form";
  /** `| undefined` (not just optional) so the Zod-inferred wire shape
   *  assigns cleanly under `exactOptionalPropertyTypes`. */
  credential_hint?: string | undefined;
}

export interface RunConversationTurnParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  /**
   * The user message that drives this turn. The caller has ALREADY
   * inserted the `conversation_messages` user row — `runLoop` is told
   * not to insert it again. `null` only for a resume with no new user
   * text (handled by `respondElicitation`, not this function).
   */
  user_message: string;
  /**
   * WHO wrote `user_message`. Required, and with no default. The fast path's
   * affirmation branch ("yes" / "ja") releases an approval the previous turn
   * minted, and on the MCP surface that message is authored by the MODEL — it
   * authenticates as a user principal all the same. A `relay` affirmation is a
   * TRIGGER, never a grant: it claims only what a person already approved at the
   * approval portal. See `conversations/answer-actor.ts`.
   */
  answer_actor: AnswerActor;
  /** Memory payload persisted on the conversation row, if any. */
  user_memory?: string | null;
  /** Permission mode resolved by the caller; falls back to the stored one. */
  permission_mode?: ConversationPermissionMode | null;
  /** Live-event emitter — keeps the HTTP/SSE surface streaming. */
  onEvent?: Parameters<typeof runLoop>[0]["onEvent"];
  /** Surface for per-variant prompts; `chat` also restricts the palette. */
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
  /** Real runtime context (engine_url, tenant_slug, actor email/role). */
  runtime_context?: {
    engine_url?: string;
    tenant_slug?: string;
    actor_email?: string;
    actor_role?: string;
  };
  /** Pre-registered AbortController for this turn's runLoop. */
  turn_abort_ctrl: AbortController;
  /** Client-side opt-out for the next-message preview frame. */
  next_suggestion_suppress?: boolean;
  /**
   * MCP-native elicitation bridge — present only for a synchronous MCP
   * `tools/call`. A backgrounded turn (the worker) passes nothing: it
   * has no live session, so input-collecting tools take the DB-pause
   * path and the conversation goes `awaiting_input`.
   */
  elicitationBridge?: ElicitationBridge;
  /**
   * Typed client event for a deterministic, no-LLM turn. Threaded only
   * from the HTTP append route (`http/routes/conversations/messages.ts`)
   * — the pg-boss / MCP async path never carries one. Handled BEFORE
   * `tryFastPath` and `runLoop`, so an event turn never reaches the
   * model. Today's only variant opens the masked `ask_user_form`
   * credential form the sk composer requests after its input-side
   * secret filter fired.
   */
  event?: RequestCredentialFormEvent;
  /**
   * Resolved principal — threaded through so the fast-path matcher can
   * enforce the same RBAC / confirm-before-execution gate the LLM tools
   * use (`tools/policy.ts`). Absent on the MCP-worker resume path
   * where no live HTTP principal exists; in that case the fast-path
   * matcher short-circuits to the LLM loop so confirmation discipline
   * stays correct.
   */
  principal?: ResolvedPrincipal | null;
}

/**
 * Run the model loop for a turn whose user message row is already
 * persisted. Reloads the conversation afterwards and emits the
 * `CONVERSATION_COMMITTED` audit row when the turn committed a
 * workflow.
 */
export async function runConversationTurn(
  p: RunConversationTurnParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");
  const effectivePermissionMode = p.permission_mode ?? getStoredPermissionMode(conv.draft);

  // Typed-event short-circuit: `request_credential_form` synthesizes
  // the exact pause the LLM produces when it calls `ask_user_form` with
  // a sensitive field — deterministic, zero LLM calls, same
  // RunLoopResult envelope as the fast path below. Runs BEFORE the
  // prose matcher: an explicit typed event outranks intent regexes.
  if (p.event?.type === "request_credential_form") {
    const result = await runRequestCredentialFormEvent(p, exec);
    if (p.onEvent) {
      for (const ev of result.events) p.onEvent(ev);
    }
    const updated = await getConversation(p.tenant_id, p.conversation_id, exec);
    if (!updated) throw new Error("conversation disappeared");
    return { conversation: updated.conversation, result };
  }

  // Fast-path matcher: deterministic intents (list_*, run <slug>,
  // inspect execution <uuid>) skip the LLM turn entirely. The matcher
  // persists the same tool-call + assistant-message rows the LLM loop
  // would produce, then short-circuits with `RunLoopResult`-shaped
  // outcome so HTTP + MCP callers see the same envelope.
  if (p.principal && p.user_message) {
    const hit = await tryFastPath({
      db: exec,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      actor_id: p.actor_id,
      principal: p.principal,
      user_message: p.user_message,
      answer_actor: p.answer_actor,
      // Thread the turn's surface so the matcher's confirm gate runs on
      // the real channel (MCP collapses inside policyDecide) instead of
      // silently defaulting every caller to chat.
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
      const updated = await getConversation(p.tenant_id, p.conversation_id, exec);
      if (!updated) throw new Error("conversation disappeared");
      return { conversation: updated.conversation, result: fastResult };
    }
  }

  const result = await runLoop({
    db: exec,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    ...(p.principal ? { principal: p.principal } : {}),
    connector_id: conv.conversation.target_connector_id,
    workflow_id: conv.conversation.target_workflow_id,
    user_message: p.user_message,
    user_message_persisted: true,
    user_memory: p.user_memory ?? null,
    model_override: conv.conversation.model,
    turn_abort_ctrl: p.turn_abort_ctrl,
    ...(p.surface ? { surface: p.surface } : {}),
    ...(p.onEvent ? { onEvent: p.onEvent } : {}),
    ...(p.runtime_context ? { runtime_context: p.runtime_context } : {}),
    ...(effectivePermissionMode ? { permission_mode: effectivePermissionMode } : {}),
    ...(p.next_suggestion_suppress !== undefined
      ? { next_suggestion_suppress: p.next_suggestion_suppress }
      : {}),
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

/**
 * Deterministic no-LLM handler for the `request_credential_form` event.
 *
 * Synthesizes row-for-row what the model loop persists when the LLM
 * calls `ask_user_form` with a password field and the DB-pause path
 * fires (`tools/sdk-wrap/invoke.ts` + `ask-user/common.ts#pauseForUserInput`):
 *
 *   1. an assistant message anchoring the turn,
 *   2. a `conversation_tool_calls` row carrying the `ask_user_form`
 *      tool_use (anchored via `parent_message_id`),
 *   3. an elicitation row PAIRED to that tool call via `tool_call_id` —
 *      a bare elicitation (`tool_call_id: null`) would orphan the
 *      resume path: `buildModelMessages` could not pair the tool_use
 *      with the answered tool_result on replay,
 *   4. the paused tool call's `{ status: "awaiting_input" }` placeholder
 *      output (never replayed once resolved — the resolved elicitation
 *      answer overrides it, exactly like the LLM path).
 *
 * The form spec is a REAL `AskUserFormInput` with `type: "password"` +
 * `sensitive: true`, so `resolveElicitation`'s existing field-metadata
 * redaction masks the typed secret at persist — zero new redaction
 * code on this path. `createElicitation` already writes the
 * APPROVAL_REQUESTED audit row and flips the conversation to
 * `awaiting_input`; nothing else is audited here.
 *
 * Nothing event-derived is persisted as a user message: the client's
 * benign prose fallback (already inserted by `appendUserMessage`) is
 * the only user-role row of the turn, so no data-as-instructions
 * channel opens.
 */
async function runRequestCredentialFormEvent(
  p: RunConversationTurnParams,
  exec: Db,
): Promise<RunLoopResult> {
  // Defensive scrub: the hint is a short kind label by contract
  // (Zod caps it at 120 chars), but it is client-supplied text headed
  // into a persisted form spec — run it through the same pattern scrub
  // `pauseForUserInput` applies to LLM-authored payloads.
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
  const elicitation = await createElicitation(
    {
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      tool_call_id: toolCallId,
      parent_message_id: assistantMessageId,
      tool_name: "ask_user_form",
      summary: question,
      input: formInput,
      actor_id: p.actor_id,
    },
    exec,
  );
  // Same pending placeholder the paused LLM tool writes (see the
  // DB-pause `data` payload in `pauseForUserInput`, persisted by
  // invoke.ts). Replay never re-sends it once answered: the resolved
  // elicitation output takes priority in `buildModelMessages`.
  await updateToolCallOutput(exec, toolCallId, {
    status: "awaiting_input",
    elicitation_id: elicitation.id,
  });
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
