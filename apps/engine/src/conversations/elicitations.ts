// Elicitation helpers — create / list / resolve rows in the
// `conversation_elicitations` table. Generalized pause-resume for any
// `askUser.*` tool.
//
// Mirrors the shape of `approval.ts` but works with the widened
// `(tool_name, input, output)` columns so a single helper serves
// `askUser.choice`, `askUser.multi`, `askUser.text`, `askUser.form`,
// and `askUser.confirm` without branching per tool.

import { and, desc, eq, inArray } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Db } from "../db/client.ts";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
} from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ElicitationStatus = "pending" | "resolved" | "cancelled" | "timeout";

export interface ElicitationRecord {
  id: string;
  conversation_id: string;
  tool_call_id: string | null;
  tool_name: string;
  summary: string;
  input: unknown;
  output: unknown;
  status: ElicitationStatus;
  decision_reason: string | null;
  created_at: string;
  /**
   * Causal anchor to the assistant message that requested this input.
   * Nullable for legacy rows; the SSE replay path falls back to placing
   * orphans after all anchored events.
   */
  parent_message_id?: string | null;
}

type Row = typeof conversationElicitations.$inferSelect;

function rowToRecord(row: Row): ElicitationRecord {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    tool_call_id: row.tool_call_id,
    tool_name: row.tool_name,
    summary: row.summary,
    input: row.input,
    output: row.output,
    status: row.status as ElicitationStatus,
    decision_reason: row.decision_reason,
    created_at: row.created_at.toISOString(),
    parent_message_id: row.parent_message_id,
  };
}

export async function createElicitation(
  p: {
    tenant_id: string;
    conversation_id: string;
    tool_call_id: string | null;
    parent_message_id?: string | null;
    tool_name: string;
    summary: string;
    input: unknown;
    actor_id: string | null;
    /** True when the row backs an MCP-native `elicitation/create`
     *  round-trip rather than the DB-pause path. Defaults false. */
    protocol_native?: boolean;
  },
  exec: Executor,
): Promise<ElicitationRecord> {
  // Single-pending-elicitation invariant. The LLM must never see two
  // open `ask_user_*` forms in the same conversation — that's how
  // session 64861a59 ended up with an orphan `tool_use_id` and a 503.
  // Any prior pending row is cancelled here and its tool_call output
  // back-filled so the persist-replay layer can pair every tool_use
  // with a tool_result.
  const stale = await exec
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.conversation_id, p.conversation_id),
        eq(conversationElicitations.status, "pending"),
      ),
    );
  if (stale.length > 0) {
    const staleIds = stale.map((row) => row.id);
    await exec
      .update(conversationElicitations)
      .set({
        status: "cancelled",
        decision_reason: "superseded_by_new_elicitation",
        decided_at: new Date(),
        updated_at: new Date(),
      })
      .where(inArray(conversationElicitations.id, staleIds));
    const staleToolCallIds = stale
      .map((row) => row.tool_call_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (staleToolCallIds.length > 0) {
      await exec
        .update(conversationToolCalls)
        .set({
          output: {
            ok: false,
            abandoned: true,
            reason: "elicitation_superseded",
          } as Record<string, unknown>,
        })
        .where(inArray(conversationToolCalls.id, staleToolCallIds));
    }
  }
  const [inserted] = await exec
    .insert(conversationElicitations)
    .values({
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      tool_call_id: p.tool_call_id,
      ...(p.parent_message_id ? { parent_message_id: p.parent_message_id } : {}),
      tool_name: p.tool_name,
      summary: p.summary,
      input: (p.input ?? {}) as Record<string, unknown>,
      status: "pending",
      protocol_native: p.protocol_native ?? false,
    })
    .returning();
  assertInsertRow(inserted, "elicitation");
  await exec
    .update(conversations)
    .set({ status: "awaiting_input", updated_at: new Date() })
    .where(eq(conversations.id, p.conversation_id));
  // Forensic log: elicitation row landed in DB and conversation
  // moved to awaiting_input. Pre-fix the dca36b29 silent failure
  // looked like "policy.gate_paused fired but the user never saw a
  // prompt" — without this row we couldn't tell whether the
  // elicitation actually persisted or whether the SSE emit dropped
  // before the wire. Carries the input.kind so an operator can
  // reason about which approval path the row belongs to without
  // dereferencing the JSONB column.
  const inputKind =
    p.input && typeof p.input === "object" && p.input !== null
      ? ((p.input as { kind?: unknown }).kind ?? null)
      : null;
  const intentKind =
    p.input && typeof p.input === "object" && p.input !== null
      ? (((p.input as { commit_intent?: { kind?: unknown } }).commit_intent?.kind ?? null) as
          | string
          | null)
      : null;
  logger.info({
    module: "conversation",
    action: "elicitation.created",
    msg: "elicitation persisted; conversation transitioned to awaiting_input",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    elicitation_id: inserted.id,
    tool_name: p.tool_name,
    ...(p.tool_call_id ? { tool_call_id: p.tool_call_id } : {}),
    ...(typeof inputKind === "string" ? { input_kind: inputKind } : {}),
    ...(typeof intentKind === "string" ? { commit_intent_kind: intentKind } : {}),
  });
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: "system",
      actor_id: p.actor_id,
      action: AuditAction.APPROVAL_REQUESTED,
      resource_type: "conversation_elicitation",
      resource_id: inserted.id,
      result: "success",
      metadata: {
        tool_name: p.tool_name,
        summary: p.summary,
        conversation_id: p.conversation_id,
      },
    },
    exec,
  );
  return rowToRecord(inserted);
}

export async function getElicitation(
  tenant_id: string,
  id: string,
  exec: Executor,
): Promise<ElicitationRecord | null> {
  const rows = await exec
    .select()
    .from(conversationElicitations)
    .where(
      and(eq(conversationElicitations.tenant_id, tenant_id), eq(conversationElicitations.id, id)),
    )
    .limit(1);
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Lookup the active (pending) elicitation tied to a tool_call. Mirrors
 * the reference impl's `resumeToolCallId` resume key — clients that
 * tracked the originating tool_call_id can resolve the elicitation
 * without first reading the elicitation_id from the SSE stream.
 *
 * Returns the most recent matching row when multiple elicitations
 * exist for the same tool_call (e.g. policy gate + LLM-emitted prompt
 * during the same turn), preferring `pending` status.
 */
export async function getPendingElicitationByToolCall(
  tenant_id: string,
  conversation_id: string,
  tool_call_id: string,
  exec: Executor,
): Promise<ElicitationRecord | null> {
  const rows = await exec
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, conversation_id),
        eq(conversationElicitations.tool_call_id, tool_call_id),
      ),
    )
    .orderBy(desc(conversationElicitations.created_at));
  if (rows.length === 0) return null;
  const pending = rows.find((r) => r.status === "pending");
  const row = pending ?? rows[0];
  return row ? rowToRecord(row) : null;
}

export async function listElicitationsForConversation(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
): Promise<ElicitationRecord[]> {
  const rows = await exec
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, conversation_id),
      ),
    )
    .orderBy(desc(conversationElicitations.created_at));
  return rows.map(rowToRecord);
}

/**
 * Back-fill `parent_message_id` on elicitation rows created during a
 * step before the step's assistant message existed. Called by the loop
 * after it inserts the assistant message in `onStepFinish`.
 */
export async function setElicitationParentMessage(
  exec: Executor,
  ids: string[],
  parent_message_id: string,
): Promise<void> {
  if (ids.length === 0) return;
  await exec
    .update(conversationElicitations)
    .set({ parent_message_id })
    .where(inArray(conversationElicitations.id, ids));
}

/**
 * Outcome of attempting to resolve an elicitation. The caller distinguishes
 * three cases:
 *   - `not_found`  → no row matches the (tenant, id) pair
 *   - `already_resolved` → the row exists but is no longer pending; carries
 *     the prior record so the route can return its decision details to the
 *     client without a second query
 *   - `resolved` → the transition fired; carries the updated record
 *
 * Without this discrimination a duplicate `/respond` POST silently
 * re-runs the conversation loop, double-charges the LLM, and confuses
 * the UI — see the silent-hang transcript in session 79bf2cca.
 */
export type ResolveElicitationResult =
  | { kind: "not_found" }
  | { kind: "already_resolved"; existing: ElicitationRecord }
  | { kind: "resolved"; record: ElicitationRecord };

export async function resolveElicitation(
  p: {
    tenant_id: string;
    id: string;
    output: unknown;
    decided_by: string | null;
    reason?: string;
    status?: "resolved" | "cancelled";
  },
  exec: Executor,
): Promise<ResolveElicitationResult> {
  const status: ElicitationStatus = p.status ?? "resolved";
  const [row] = await exec
    .update(conversationElicitations)
    .set({
      status,
      output: (p.output ?? null) as Record<string, unknown> | null,
      decided_by: p.decided_by,
      decided_at: new Date(),
      decision_reason: p.reason ?? null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.id, p.id),
        eq(conversationElicitations.status, "pending"),
      ),
    )
    .returning();
  if (!row) {
    // The conditional update missed: either no such row, or the row is
    // already in a terminal state. Read it back so we can tell the caller
    // which case it is.
    const [existing] = await exec
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, p.tenant_id),
          eq(conversationElicitations.id, p.id),
        ),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" };
    return { kind: "already_resolved", existing: rowToRecord(existing) };
  }
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.decided_by ? "user" : "system",
      actor_id: p.decided_by,
      action: status === "resolved" ? AuditAction.APPROVAL_APPROVED : AuditAction.APPROVAL_REJECTED,
      resource_type: "conversation_elicitation",
      resource_id: row.id,
      result: "success",
      reason: p.reason ?? null,
      metadata: {
        conversation_id: row.conversation_id,
        tool_name: row.tool_name,
      },
    },
    exec,
  );
  return { kind: "resolved", record: rowToRecord(row) };
}
