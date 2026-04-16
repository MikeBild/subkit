// Approval request helpers — create, poll, resolve.

import { and, desc, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { approvalRequests, conversations } from "../db/schema/index.ts";
import type { ApprovalKind, ApprovalRequestRecord, ApprovalStatus } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

type Row = typeof approvalRequests.$inferSelect;

function rowToRecord(row: Row): ApprovalRequestRecord {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    tool_call_id: row.tool_call_id,
    kind: row.kind as ApprovalKind,
    summary: row.summary,
    diff: row.diff,
    status: row.status as ApprovalStatus,
    decision_reason: row.decision_reason,
    created_at: row.created_at.toISOString(),
  };
}

export async function createApprovalRequest(
  p: {
    tenant_id: string;
    conversation_id: string;
    tool_call_id: string | null;
    kind: ApprovalKind;
    summary: string;
    diff?: unknown;
    actor_id: string | null;
  },
  exec: Executor,
): Promise<ApprovalRequestRecord> {
  const [inserted] = await exec
    .insert(approvalRequests)
    .values({
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      tool_call_id: p.tool_call_id,
      kind: p.kind,
      summary: p.summary,
      diff: (p.diff ?? null) as Record<string, unknown> | null,
      status: "pending",
    })
    .returning();
  if (!inserted) throw new Error("approval insert returned no row");
  await exec
    .update(conversations)
    .set({ status: "awaiting_approval", updated_at: new Date() })
    .where(eq(conversations.id, p.conversation_id));
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: "system",
      actor_id: p.actor_id,
      action: AuditAction.APPROVAL_REQUESTED,
      resource_type: "approval_request",
      resource_id: inserted.id,
      result: "success",
      metadata: { kind: p.kind, summary: p.summary, conversation_id: p.conversation_id },
    },
    exec,
  );
  return rowToRecord(inserted);
}

export async function getApprovalRequest(
  tenant_id: string,
  id: string,
  exec: Executor,
): Promise<ApprovalRequestRecord | null> {
  const rows = await exec
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenant_id, tenant_id), eq(approvalRequests.id, id)))
    .limit(1);
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}

export async function listApprovalsForConversation(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
): Promise<ApprovalRequestRecord[]> {
  const rows = await exec
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenant_id, tenant_id),
        eq(approvalRequests.conversation_id, conversation_id),
      ),
    )
    .orderBy(desc(approvalRequests.created_at));
  return rows.map(rowToRecord);
}

export async function resolveApproval(
  p: {
    tenant_id: string;
    id: string;
    status: "approved" | "rejected";
    decided_by: string | null;
    reason?: string;
  },
  exec: Executor,
): Promise<ApprovalRequestRecord | null> {
  const [row] = await exec
    .update(approvalRequests)
    .set({
      status: p.status,
      decided_by: p.decided_by,
      decided_at: new Date(),
      decision_reason: p.reason ?? null,
      updated_at: new Date(),
    })
    .where(and(eq(approvalRequests.tenant_id, p.tenant_id), eq(approvalRequests.id, p.id)))
    .returning();
  if (!row) return null;
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.decided_by ? "user" : "system",
      actor_id: p.decided_by,
      action:
        p.status === "approved" ? AuditAction.APPROVAL_APPROVED : AuditAction.APPROVAL_REJECTED,
      resource_type: "approval_request",
      resource_id: row.id,
      result: "success",
      reason: p.reason ?? null,
      metadata: { conversation_id: row.conversation_id, kind: row.kind },
    },
    exec,
  );
  return rowToRecord(row);
}
