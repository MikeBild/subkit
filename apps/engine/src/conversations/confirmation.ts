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
import { conversationToolCalls } from "../db/schema/index.ts";
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
 * Persist a confirmation state transition on a tool-call row and append
 * an interaction_log entry. Idempotent-ish: callers should check that
 * the target state is not already the current state before invoking.
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
