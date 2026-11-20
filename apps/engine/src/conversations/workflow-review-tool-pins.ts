import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { workflowReviewReceipts } from "../db/schema/index.ts";
import { can } from "../rbac/evaluator.ts";
import { resolveWorkflowReviewManifest } from "../workflows/review-manifest.ts";
import { assertToolPinsCurrent } from "../workflows/tool-pin-review.ts";

export async function assertReviewedToolPinsCurrent(
  db: Db,
  p: {
    tenant_id: string;
    conversation_id: string;
    receipt_id: string;
    principal: ResolvedPrincipal;
    session_id: string;
  },
): Promise<void> {
  const [receipt] = await db
    .select()
    .from(workflowReviewReceipts)
    .where(
      and(
        eq(workflowReviewReceipts.tenant_id, p.tenant_id),
        eq(workflowReviewReceipts.conversation_id, p.conversation_id),
        eq(workflowReviewReceipts.id, p.receipt_id),
      ),
    )
    .limit(1);
  if (
    !receipt ||
    receipt.status === "completed" ||
    receipt.prepared_by !== p.principal.id ||
    receipt.session_id !== p.session_id
  )
    return;
  const snapshot = receipt.snapshot as {
    saved_definition?: unknown;
    actions?: { grant?: { environment?: "dev" | "prod" } | null };
  };
  const environment = snapshot.actions?.grant?.environment;
  if (!environment || snapshot.saved_definition === undefined) return;
  const permission = await can(db, {
    tenant_id: p.tenant_id,
    principal: p.principal,
    permission: "workflow:write",
    ...(receipt.workflow_id ? { resource: { type: "workflow", id: receipt.workflow_id } } : {}),
  });
  if (!permission.allow) return;
  const reviewed = await resolveWorkflowReviewManifest(
    {
      tenant_id: p.tenant_id,
      workflow_id: receipt.workflow_id,
      definition: snapshot.saved_definition,
      environment,
    },
    db,
  );
  await assertToolPinsCurrent(db, p.tenant_id, reviewed.manifest.effects);
}
