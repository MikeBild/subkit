// Shared helpers + error types + lightweight result shapes used by
// every per-operation module under `service/`. After the Phase 4
// split (audit §4.1) every per-operation file imports from here.

import type { Executor } from "../../db/client.ts";
import type { conversations } from "../../db/schema/index.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import { appendSnapshot } from "../draft.ts";
import type { RunLoopResult } from "../loop.ts";
import type {
  ConversationPermissionMode,
  ConversationRecord,
  ConversationStatus,
  DraftDocument,
} from "../types.ts";

export type { Executor };

export function normalizePermissionMode(value: unknown): ConversationPermissionMode | null {
  return value === "auto" || value === "ask" || value === "plan" || value === "yolo" ? value : null;
}

export function getStoredPermissionMode(
  draft: DraftDocument | null | undefined,
): ConversationPermissionMode | null {
  return normalizePermissionMode(draft?.session?.permission_mode);
}

export async function persistPermissionModeIfChanged(params: {
  exec: Executor;
  tenant_id: string;
  conversation_id: string;
  draft: DraftDocument | null | undefined;
  permission_mode: ConversationPermissionMode | null;
}): Promise<void> {
  const current = getStoredPermissionMode(params.draft);
  const nextMode = normalizePermissionMode(params.permission_mode);
  // Non-sticky modes (yolo) never overwrite the stored sticky mode.
  // Treat them as a no-op so the next non-yolo turn picks up the
  // operator's previous auto/ask/plan choice.
  if (nextMode === "yolo") return;
  if (current === nextMode) return;
  const baseDraft = params.draft ?? createEmptyDraftDocument();
  await appendSnapshot(
    params.tenant_id,
    params.conversation_id,
    {
      ...baseDraft,
      session: {
        ...(baseDraft.session ?? {}),
        permission_mode: nextMode,
      },
    },
    params.exec,
  );
}

export function rowToRecord(row: typeof conversations.$inferSelect): ConversationRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    target_workflow_id: row.target_workflow_id,
    target_connector_id: row.target_connector_id,
    status: row.status as ConversationStatus,
    owner_id: row.owner_id ?? null,
    model: row.model ?? null,
    title: row.title ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function isAskUserToolName(value: string | null | undefined): boolean {
  return (
    value === "ask_user_choice" ||
    value === "ask_user_multi" ||
    value === "ask_user_text" ||
    value === "ask_user_form" ||
    value === "ask_user_confirm"
  );
}

export interface ConversationTurnOutcome {
  conversation: ConversationRecord;
  result: RunLoopResult;
}

export interface PendingElicitationSummary {
  id: string;
  tool_name: string;
  summary: string;
  /**
   * The gated tool-call row id and the full tool input. Carried so a
   * client that raced a plain prompt against a just-arrived
   * elicitation can RESTORE the dialog from the rejection alone —
   * without these the CLI dropped `pending_elicitation` to null and
   * the session deadlocked (every later prompt blocked, no dialog to
   * answer). Optional so older callers still type-check.
   */
  tool_call_id?: string | null;
  input?: unknown;
}

export class PendingElicitationBlockedError extends Error {
  readonly pending_elicitation: PendingElicitationSummary;

  constructor(pending: PendingElicitationSummary) {
    super("resolve the pending dialog before sending another prompt");
    this.name = "PendingElicitationBlockedError";
    this.pending_elicitation = pending;
  }
}

/**
 * Raised when a duplicate `/respond` POST lands for an elicitation that
 * is already terminal. Without this guard a second response re-runs the
 * conversation loop, double-charges the LLM, and produces the silent
 * "approve approve …" UI seen in session 79bf2cca.
 */
export class ElicitationAlreadyResolvedError extends Error {
  readonly elicitation_id: string;
  readonly status: "resolved" | "cancelled" | "timeout";
  readonly previous_output: unknown;
  readonly previous_decision_reason: string | null;

  constructor(p: {
    elicitation_id: string;
    status: "resolved" | "cancelled" | "timeout";
    previous_output: unknown;
    previous_decision_reason: string | null;
  }) {
    super(`elicitation ${p.elicitation_id} is already ${p.status}`);
    this.name = "ElicitationAlreadyResolvedError";
    this.elicitation_id = p.elicitation_id;
    this.status = p.status;
    this.previous_output = p.previous_output;
    this.previous_decision_reason = p.previous_decision_reason;
  }
}
