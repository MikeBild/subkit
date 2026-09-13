// Confirmation state machine for tool outputs.
//
// Replaces the binary "approval_required" flag with a typed multi-state
// transition log. Each confirmable tool declares its `validActions` set;
// the loop runs a pre-LLM-call pass that processes any pending
// confirmations and rewrites the corresponding tool-result payloads so
// the model sees the outcome on the next turn.
//
// States:
//   proposed       — tool call emitted a confirmation request
//   tested         — user tested the proposed change (read-only preview)
//   confirmed      — user approved; tool should execute the real write
//   partial        — user approved a subset; tool should execute only
//                    that subset
//   declined       — user rejected
//   auto_declined  — timeout / superseded by a later user message
//   oauth_success  — OAuth authorize flow completed
//   oauth_failure  — OAuth authorize flow errored
//
// The interaction_log (on conversation_tool_calls.interaction_log) is
// append-only. Every state transition writes one entry.

import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { conversationMessages, conversationToolCalls } from "../db/schema/index.ts";
import { recordConfirmationTransition } from "../observability/instrumentation.ts";

export type ConfirmationState =
  | "proposed"
  | "tested"
  | "confirmed"
  | "partial"
  | "declined"
  | "auto_declined"
  | "oauth_success"
  | "oauth_failure";

export interface InteractionLogEntry {
  type: string;
  ts: string;
  meta?: Record<string, unknown>;
}

export interface ConfirmationConfig {
  /** Valid states the tool recognises. */
  validActions: ReadonlyArray<ConfirmationState>;
  /**
   * Process a pending confirmation: given the prior tool output and the
   * state-change event, return the new output payload + status. Called
   * once per state transition.
   */
  processConfirmation(
    input: unknown,
    currentOutput: unknown,
    newState: ConfirmationState,
    data: Record<string, unknown> | undefined,
  ): Promise<{ status: "completed" | "declined"; output: unknown }>;
}

/**
 * Human-readable transcript marker for each terminal transition. The
 * markers are short, deterministic strings that render cleanly in the
 * chat scrollback so the user can see their own approve/decline action
 * — the confirmation dialog itself is ephemeral, and prior to this
 * marker the decision was only visible as `interaction_log` metadata
 * buried on the tool-call row.
 */
function transcriptMarkerFor(state: ConfirmationState, tool: string | undefined): string | null {
  const label = tool ?? "action";
  switch (state) {
    case "confirmed":
      return `✓ Approved: ${label}`;
    case "declined":
      return `✗ Declined: ${label}`;
    case "partial":
      return `◐ Partially approved: ${label}`;
    case "auto_declined":
      return `✗ Auto-declined: ${label} (superseded by a later message)`;
    case "oauth_success":
      return `✓ OAuth completed: ${label}`;
    case "oauth_failure":
      return `✗ OAuth failed: ${label}`;
    default:
      // `proposed` and `tested` are intermediate states; don't clutter the
      // transcript with a message for them.
      return null;
  }
}

/**
 * Persist a confirmation state transition on a tool-call row and append
 * an interaction_log entry. When a `conversation_id` is supplied, also
 * append a short user-visible transcript message describing the choice
 * so the user's approve/decline click isn't silently absorbed into
 * metadata. Idempotent-ish: callers should check that the target state
 * is not already the current state before invoking.
 */
export async function recordTransition(
  db: Db,
  params: {
    tool_call_id: string;
    tenant_id: string;
    to_state: ConfirmationState;
    data?: Record<string, unknown>;
    actor_id?: string | null;
    /** Tool name — populated by callers for observability labelling. */
    tool?: string;
    /**
     * Conversation the tool call belongs to. When supplied, a visible
     * `role: "user"` message is inserted alongside the interaction_log
     * append, so the user's decision shows up in the transcript. Omit
     * in tests or in internal transitions that shouldn't render.
     */
    conversation_id?: string;
  },
): Promise<void> {
  const entry: InteractionLogEntry = {
    type: `user_${params.to_state}`,
    ts: new Date().toISOString(),
    ...(params.actor_id || params.data
      ? {
          meta: {
            ...(params.actor_id ? { actor_id: params.actor_id } : {}),
            ...(params.data ?? {}),
          },
        }
      : {}),
  };
  await db
    .update(conversationToolCalls)
    .set({
      confirmation_state: params.to_state,
      ...(params.data !== undefined ? { confirmation_data: params.data } : {}),
      interaction_log: sql`COALESCE(${conversationToolCalls.interaction_log}, '[]'::jsonb) || ${JSON.stringify(
        [entry],
      )}::jsonb`,
    })
    .where(
      and(
        eq(conversationToolCalls.id, params.tool_call_id),
        eq(conversationToolCalls.tenant_id, params.tenant_id),
      ),
    );

  if (params.conversation_id) {
    const marker = transcriptMarkerFor(params.to_state, params.tool);
    if (marker) {
      await db.insert(conversationMessages).values({
        tenant_id: params.tenant_id,
        conversation_id: params.conversation_id,
        role: "user",
        content: {
          kind: "confirmation_decision",
          text: marker,
          tool: params.tool ?? null,
          to_state: params.to_state,
          tool_call_id: params.tool_call_id,
        } as Record<string, unknown>,
      });
    }
  }

  recordConfirmationTransition({ to_state: params.to_state, tool: params.tool ?? "unknown" });
}

/**
 * Scan a message history for tool_call rows in a pending confirmation
 * state. Intended for the pre-LLM-call pass in the conversation loop.
 * Returns the set of tool_call ids whose state is one the tool accepts.
 */
export function isTerminalState(s: ConfirmationState): boolean {
  return (
    s === "confirmed" ||
    s === "partial" ||
    s === "declined" ||
    s === "auto_declined" ||
    s === "oauth_success" ||
    s === "oauth_failure"
  );
}
