import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { hostedWorkAdmissions } from "../db/schema/index.ts";
import { tenantWorkSnapshot } from "../execution/tenant-work.ts";
import { principalHolds } from "../rbac/evaluator.ts";
import { isHostedWorkRunningLocally } from "./hosted-work.ts";

export const HostedWorkStopReviewSchema = z
  .object({
    admission_id: z.uuid(),
    owner_boot_id: z.uuid(),
    reviewed_owner_stop_evidence: z.string().trim().min(120).max(16000),
    all_work_from_owner_stopped: z.literal(true),
  })
  .strict();

export class HostedWorkReviewError extends Error {
  constructor(
    readonly code: "operator_browser_required" | "work_review_conflict",
    message: string,
  ) {
    super(message);
  }
}

async function requireOperatorBrowser(db: Db, principal: ResolvedPrincipal): Promise<void> {
  if (
    principal.kind !== "user" ||
    principal.auth_source?.kind !== "browser_session" ||
    !principal.session_id ||
    principal.auth_source.session_id !== principal.session_id ||
    !(await principalHolds(db, principal, "settings:write:global"))
  )
    throw new HostedWorkReviewError(
      "operator_browser_required",
      "Hosted work reconciliation requires an authenticated operator browser review",
    );
}

export async function listHostedWorkForReview(
  db: Db,
  tenantId: string,
  principal: ResolvedPrincipal,
) {
  await requireOperatorBrowser(db, principal);
  const rows = await db
    .select()
    .from(hostedWorkAdmissions)
    .where(
      and(
        eq(hostedWorkAdmissions.tenant_id, tenantId),
        inArray(hostedWorkAdmissions.state, ["active", "reconciliation_required"]),
      ),
    )
    .orderBy(asc(hostedWorkAdmissions.created_at), asc(hostedWorkAdmissions.id))
    .limit(101);
  const bootId = tenantWorkSnapshot(tenantId).boot_id;
  return {
    items: rows.slice(0, 100).map((row) => ({
      admission_id: row.id,
      tenant_id: row.tenant_id,
      kind: row.kind,
      state: row.state,
      owner_boot_id: row.owner_boot_id,
      started_at: row.created_at.toISOString(),
      current_process: row.owner_boot_id === bootId || isHostedWorkRunningLocally(row.id),
    })),
    has_more: rows.length > 100,
  };
}

export async function reconcileHostedWorkAfterReviewedOwnerStop(
  db: Db,
  tenantId: string,
  principal: ResolvedPrincipal,
  input: z.input<typeof HostedWorkStopReviewSchema>,
) {
  const review = HostedWorkStopReviewSchema.parse(input);
  await requireOperatorBrowser(db, principal);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-work:${tenantId}`}, 0))`,
    );
    const [row] = await tx
      .select()
      .from(hostedWorkAdmissions)
      .where(
        and(
          eq(hostedWorkAdmissions.tenant_id, tenantId),
          eq(hostedWorkAdmissions.id, review.admission_id),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !row ||
      !["active", "reconciliation_required"].includes(row.state) ||
      row.owner_boot_id !== review.owner_boot_id
    )
      throw new HostedWorkReviewError(
        "work_review_conflict",
        "Hosted work stop review does not match an unresolved admission",
      );
    if (
      row.owner_boot_id === tenantWorkSnapshot(tenantId).boot_id ||
      isHostedWorkRunningLocally(row.id)
    )
      throw new HostedWorkReviewError(
        "work_review_conflict",
        "Work owned by this running process cannot be reconciled",
      );
    const digest = createHash("sha256").update(review.reviewed_owner_stop_evidence).digest("hex");
    await tx
      .update(hostedWorkAdmissions)
      .set({ state: "released", released_at: new Date(), evidence_sha256: digest })
      .where(
        and(eq(hostedWorkAdmissions.tenant_id, tenantId), eq(hostedWorkAdmissions.id, row.id)),
      );
    await auditAwait(
      {
        tenant_id: tenantId,
        action: AuditAction.HOSTED_WORK_RECONCILED,
        actor_type: "user",
        actor_id: principal.id,
        resource_type: "hosted_work",
        resource_id: row.id,
        result: "success",
        reason: "operator_reviewed_owner_stop",
        metadata: {
          owner_boot_id: row.owner_boot_id,
          evidence_sha256: digest,
          operator_tenant_id: principal.tenant_id,
        },
      },
      tx,
    );
    return { admission_id: row.id, state: "released" as const, evidence_sha256: digest };
  });
}
