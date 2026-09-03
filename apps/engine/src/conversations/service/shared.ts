// Shared helpers + error types + lightweight result shapes used by
// every per-operation module under `service/`. Each per-operation file
// imports from here.

import { and, eq, inArray } from "drizzle-orm";
import type { Db, Executor } from "../../db/client.ts";
import { type conversations, systemAccounts, users } from "../../db/schema/index.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import { appendSnapshot } from "../draft.ts";
import type { RunLoopResult } from "../loop.ts";
import { elicitationInputForClient } from "../tools/ask-user/commit-intent.ts";
import type {
  ConversationOwner,
  ConversationPermissionMode,
  ConversationRecord,
  ConversationStatus,
  DraftDocument,
} from "../types.ts";

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
    title_locked: row.title_locked ?? false,
    origin_client: row.origin_client ?? null,
    surface: row.surface ?? null,
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

/**
 * Raised when a prompt (or a direct tool invoke) races an open `ask_user_*`
 * dialog. Serialized into HTTP 409 bodies, SSE error frames, and the chat
 * dispatcher's typed-reply salvage, so the persisted prompt it carries is
 * projected through `elicitationInputForClient` HERE, in the constructor — the
 * engine-authored `commit_intent.payload.approval_id` on a policy-gate row is an
 * internal coordinate of a governance decision, and every one of those readers
 * would otherwise have to remember to strip it.
 */
export class PendingElicitationBlockedError extends Error {
  readonly pending_elicitation: PendingElicitationSummary;

  constructor(pending: PendingElicitationSummary) {
    super("resolve the pending dialog before sending another prompt");
    this.name = "PendingElicitationBlockedError";
    this.pending_elicitation =
      "input" in pending
        ? { ...pending, input: elicitationInputForClient(pending.input) }
        : pending;
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

/** Owner names for a page of rows: people by e-mail, machine accounts by name. */
export async function loadOwners(
  tenant_id: string,
  ownerIds: Array<string | null>,
  exec: Db,
): Promise<Map<string, ConversationOwner>> {
  const ids = [...new Set(ownerIds.filter((id): id is string => typeof id === "string"))];
  const out = new Map<string, ConversationOwner>();
  if (ids.length === 0) return out;
  const [people, machines] = await Promise.all([
    exec
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.tenant_id, tenant_id), inArray(users.id, ids))),
    exec
      .select({ id: systemAccounts.id, name: systemAccounts.name })
      .from(systemAccounts)
      .where(and(eq(systemAccounts.tenant_id, tenant_id), inArray(systemAccounts.id, ids))),
  ]);
  for (const u of people) out.set(u.id, { id: u.id, kind: "user", name: u.email });
  for (const m of machines) out.set(m.id, { id: m.id, kind: "system_account", name: m.name });
  return out;
}
