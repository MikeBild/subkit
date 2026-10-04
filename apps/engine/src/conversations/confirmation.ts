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
  validActions: ReadonlyArray<ConfirmationState>;
  processConfirmation(
    input: unknown,
    currentOutput: unknown,
    newState: ConfirmationState,
    data: Record<string, unknown> | undefined,
  ): Promise<{ status: "completed" | "declined"; output: unknown }>;
}

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
      return null;
  }
}

export async function recordTransition(
  db: Db,
  params: {
    tool_call_id: string;
    tenant_id: string;
    to_state: ConfirmationState;
    data?: Record<string, unknown>;
    actor_id?: string | null;
    tool?: string;
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
