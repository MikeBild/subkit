import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Db } from "../db/client.ts";
import { hostedControlReceiptId } from "../db/hosted-control-receipt.ts";
import { auditLog, hostedStorageObjects, tenants } from "../db/schema/index.ts";
import { beginTenantWork, tenantWorkSnapshot } from "../execution/tenant-work.ts";
import { withContext } from "../logging/context.ts";
import { listUnsettledHostedWork } from "../queue/index.ts";
import { principalHolds } from "../rbac/evaluator.ts";
import { now } from "../utils/clock.ts";
import { hostedObjectNamespace } from "./hosted-objects.ts";
import { getObjectStore, type ObjectStore } from "./object-store.ts";

export const HostedObjectStopReviewSchema = z
  .object({
    reservation_id: z.uuid(),
    storage_namespace: z.string().regex(/^[0-9a-f]{64}$/),
    expected_updated_at: z.iso.datetime(),
    all_possible_upload_origins_stopped: z.literal(true),
    all_remote_puts_terminal: z.literal(true),
    reviewed_remote_stop_evidence: z.string().trim().min(120).max(16000),
  })
  .strict();

export class HostedObjectReviewError extends Error {
  constructor(
    readonly code:
      | "operator_browser_required"
      | "storage_review_conflict"
      | "storage_operation_failed",
    message: string,
  ) {
    super(message);
    this.name = "HostedObjectReviewError";
  }
}

async function requireOperatorBrowser(db: Db, principal: ResolvedPrincipal): Promise<void> {
  if (
    principal.kind !== "user" ||
    principal.auth_source?.kind !== "browser_session" ||
    !principal.session_id ||
    principal.auth_source.session_id !== principal.session_id ||
    !(await principalHolds(db, principal, "settings:write:global"))
  ) {
    throw new HostedObjectReviewError(
      "operator_browser_required",
      "Storage reconciliation requires an authenticated operator browser review",
    );
  }
}

function conflict(message: string): never {
  throw new HostedObjectReviewError("storage_review_conflict", message);
}

async function boundedObjectOperation<T>(
  tenantId: string,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const finish = beginTenantWork(tenantId);
  const task = Promise.resolve()
    .then(operation)
    .then(
      (value) => {
        finish();
        return value;
      },
      (error) => {
        finish();
        throw error;
      },
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("object_operation_timeout")), timeoutMs);
      }),
    ]);
  } catch {
    throw new HostedObjectReviewError(
      "storage_operation_failed",
      "Object cleanup did not finish with verified absence; the reservation remains charged",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function listHostedObjectsForReview(
  db: Db,
  tenantId: string,
  principal: ResolvedPrincipal,
) {
  z.uuid().parse(tenantId);
  await requireOperatorBrowser(db, principal);
  const [tenant] = await db
    .select({ origin: tenants.origin })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (tenant?.origin !== "self_service") conflict("Storage review target is not a hosted tenant");
  const rows = await db
    .select()
    .from(hostedStorageObjects)
    .where(
      and(eq(hostedStorageObjects.tenant_id, tenantId), eq(hostedStorageObjects.state, "pending")),
    )
    .orderBy(asc(hostedStorageObjects.created_at), asc(hostedStorageObjects.id))
    .limit(101);
  return {
    items: rows.slice(0, 100).map((row) => ({
      reservation_id: row.id,
      tenant_id: row.tenant_id,
      storage_key: row.storage_key,
      storage_namespace: row.storage_namespace,
      declared_bytes: row.declared_bytes.toString(),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    })),
    has_more: rows.length > 100,
  };
}

export async function reconcileHostedObjectAfterReviewedRemoteStop(
  db: Db,
  tenantId: string,
  principal: ResolvedPrincipal,
  input: z.input<typeof HostedObjectStopReviewSchema>,
  dependencies: { objects?: ObjectStore; operationTimeoutMs?: number } = {},
) {
  z.uuid().parse(tenantId);
  const review = HostedObjectStopReviewSchema.parse(input);
  const timeoutMs = z
    .number()
    .int()
    .positive()
    .max(30000)
    .parse(dependencies.operationTimeoutMs ?? 5000);
  await requireOperatorBrowser(db, principal);
  const expectedTimestamp = new Date(review.expected_updated_at).toISOString();
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "hosted-object-remote-stop",
        tenantId,
        review.reservation_id,
        review.storage_namespace,
        expectedTimestamp,
        review.reviewed_remote_stop_evidence,
      ]),
    )
    .digest("hex");
  const receiptId = hostedControlReceiptId(
    tenantId,
    "hosted_storage_object",
    review.reservation_id,
  );
  return db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, tenantId);
    const [tenant] = await tx
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for("update")
      .limit(1);
    if (tenant?.origin !== "self_service") conflict("Storage review target is not a hosted tenant");
    const [receipt] = await tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.id, receiptId)))
      .limit(1);
    if (receipt) {
      const metadata = z
        .object({
          evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
          storage_namespace: z.string().regex(/^[0-9a-f]{64}$/),
          operator_tenant_id: z.uuid(),
        })
        .strict()
        .safeParse(receipt.metadata);
      if (
        receipt.action !== AuditAction.HOSTED_STORAGE_OBJECT_RECONCILED ||
        receipt.resource_type !== "hosted_storage_object" ||
        receipt.resource_id !== review.reservation_id ||
        !metadata.success ||
        metadata.data.evidence_sha256 !== digest ||
        metadata.data.storage_namespace !== review.storage_namespace
      )
        conflict("Storage stop review differs from its completed receipt");
      return {
        reservation_id: review.reservation_id,
        state: "resolved_absent" as const,
        evidence_sha256: digest,
      };
    }
    if (
      tenant.status !== "pending_deletion" ||
      tenant.deleted_at !== null ||
      !tenant.deletion_scheduled_for ||
      tenant.deletion_scheduled_for.getTime() > now()
    )
      conflict("Storage recovery requires a hosted tenant whose deletion grace has expired");
    if (
      tenantWorkSnapshot(tenantId).in_flight > 0 ||
      (await listUnsettledHostedWork(tenantId, tx)).length > 0
    )
      conflict("Storage recovery requires all local and persisted work to be stopped");
    const [row] = await tx
      .select()
      .from(hostedStorageObjects)
      .where(
        and(
          eq(hostedStorageObjects.tenant_id, tenantId),
          eq(hostedStorageObjects.id, review.reservation_id),
        ),
      )
      .for("update")
      .limit(1);
    if (
      row?.state !== "pending" ||
      row.updated_at.toISOString() !== expectedTimestamp ||
      row.storage_namespace !== review.storage_namespace ||
      row.storage_namespace !== hostedObjectNamespace()
    )
      conflict("Storage stop review does not match the unresolved object and configured namespace");
    let objects: ObjectStore;
    try {
      objects = dependencies.objects ?? getObjectStore();
    } catch {
      throw new HostedObjectReviewError(
        "storage_operation_failed",
        "Object storage is unavailable; the reservation remains charged",
      );
    }
    await boundedObjectOperation(tenantId, () => objects.delete(row.storage_key), timeoutMs);
    if (await boundedObjectOperation(tenantId, () => objects.head(row.storage_key), timeoutMs))
      conflict("The exact object still exists; storage usage cannot be released");
    await withContext({ execution_privacy: undefined, auth_via: undefined }, () =>
      auditAwait(
        {
          id: receiptId,
          tenant_id: tenantId,
          actor_type: "user",
          actor_id: principal.id,
          action: AuditAction.HOSTED_STORAGE_OBJECT_RECONCILED,
          resource_type: "hosted_storage_object",
          resource_id: row.id,
          result: "success",
          reason: "operator_reviewed_remote_upload_stop",
          metadata: {
            storage_namespace: row.storage_namespace,
            evidence_sha256: digest,
            operator_tenant_id: principal.tenant_id,
          },
        },
        tx,
      ),
    );
    await tx
      .update(hostedStorageObjects)
      .set({
        state: "absence_verified",
        absence_verified_at: new Date(now()),
        updated_at: new Date(now()),
      })
      .where(
        and(eq(hostedStorageObjects.tenant_id, tenantId), eq(hostedStorageObjects.id, row.id)),
      );
    await tx
      .delete(hostedStorageObjects)
      .where(
        and(eq(hostedStorageObjects.tenant_id, tenantId), eq(hostedStorageObjects.id, row.id)),
      );
    return { reservation_id: row.id, state: "resolved_absent" as const, evidence_sha256: digest };
  });
}
