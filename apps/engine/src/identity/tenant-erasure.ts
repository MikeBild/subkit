import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditAction, auditAwait } from "../audit/index.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import { type Executor, getDb, type Transaction } from "../db/client.ts";
import { withTenantScope } from "../db/index.ts";
import {
  authIdentities,
  chatWorkspaces,
  events,
  identityRecoverySessions,
  runtimeConfigReplicas,
  tenantErasureStates,
  tenants,
  users,
} from "../db/schema/index.ts";
import { tenantWorkSnapshot } from "../execution/tenant-work.ts";
import { listUnsettledHostedWork, releaseStoppedPendingHostedWork } from "../queue/hosted-work.ts";
import {
  eraseTenantQueueJobs,
  type TenantErasureQueue,
  TenantQueueDrainRequired,
} from "../queue/tenant-erasure.ts";
import {
  eraseTenantRuntimeArtifacts,
  forgetErasedTenantRuntimeConfig,
} from "../runtime-config/tenant-erasure.ts";
import {
  assertHostedObjectErasureReady,
  markErasedHostedObjects,
} from "../storage/hosted-objects.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { now } from "../utils/clock.ts";
import {
  assertNoCrossTenantErasureReferences,
  erasureTableOrder,
} from "./tenant-erasure-schema.ts";

const LEASE_MS = 5 * 60_000;
export interface TenantErasureDependencies {
  queue: TenantErasureQueue;
  objects: ObjectStore;
}

async function dueTenant(tenantId: string, tx: Transaction) {
  await lockCatalogVocabulary(tx, tenantId);
  const [tenant] = await tx
    .select()
    .from(tenants)
    .where(
      and(
        eq(tenants.id, tenantId),
        eq(tenants.origin, "self_service"),
        eq(tenants.status, "pending_deletion"),
        isNull(tenants.deleted_at),
        lte(tenants.deletion_scheduled_for, new Date(now())),
      ),
    )
    .for("update")
    .limit(1);
  return tenant;
}

async function checkpoint(
  tenantId: string,
  leaseOwner: string,
  stage: "queue_cleared" | "objects_cleared",
  db: Executor,
) {
  await db.transaction(async (tx) => {
    const [state] = await tx
      .update(tenantErasureStates)
      .set({
        stage,
        lease_expires_at: new Date(now() + LEASE_MS),
        failure_code: null,
        drain_boot_id: null,
        drain_untracked: false,
        updated_at: new Date(now()),
      })
      .where(
        and(
          eq(tenantErasureStates.tenant_id, tenantId),
          eq(tenantErasureStates.lease_owner, leaseOwner),
        ),
      )
      .returning({ tenant_id: tenantErasureStates.tenant_id });
    if (!state) throw new Error("tenant_erasure_lease_lost");
    await auditAwait(
      {
        tenant_id: tenantId,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.TENANT_UPDATED,
        resource_type: "tenant",
        resource_id: tenantId,
        result: "success",
        metadata: { source: "tenant_erasure", stage },
      },
      tx,
    );
  });
}

export async function eraseExpiredTenant(
  tenantIdInput: string,
  dependencies: TenantErasureDependencies,
  exec?: Executor,
) {
  const tenantId = z.uuid().parse(tenantIdInput);
  const db = exec ?? getDb();
  const order = erasureTableOrder();
  const leaseOwner = randomUUID();
  const claim = await db.transaction(async (tx) => {
    const tenant = await dueTenant(tenantId, tx);
    if (!tenant) return null;
    // tenant-filter:exempt — erasure is limited to a single live engine replica until distributed producer-drain receipts exist.
    const replicas = await tx
      .select({ id: runtimeConfigReplicas.instance_id })
      .from(runtimeConfigReplicas)
      .where(sql`${runtimeConfigReplicas.last_seen_at}>${new Date(now() - 30_000)}`);
    if (replicas.length > 1) throw new Error("tenant_erasure_multiple_replicas_unsupported");
    await tx.insert(tenantErasureStates).values({ tenant_id: tenantId }).onConflictDoNothing();
    const [state] = await tx
      .select()
      .from(tenantErasureStates)
      .where(eq(tenantErasureStates.tenant_id, tenantId))
      .for("update")
      .limit(1);
    if (
      !state ||
      state.stage === "completed" ||
      (state.lease_expires_at && state.lease_expires_at.getTime() > now())
    )
      return null;
    const snapshot = tenantWorkSnapshot(tenantId);
    if (state.drain_untracked || (state.drain_boot_id && state.drain_boot_id !== snapshot.boot_id))
      return { blocked: true as const };
    try {
      await assertNoCrossTenantErasureReferences(tenantId, tx);
    } catch {
      await tx
        .update(tenantErasureStates)
        .set({ failure_code: "tenant_reference_review_required", updated_at: new Date(now()) })
        .where(eq(tenantErasureStates.tenant_id, tenantId));
      await auditAwait(
        {
          tenant_id: tenantId,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.TENANT_UPDATED,
          resource_type: "tenant",
          resource_id: tenantId,
          result: "error",
          reason: "tenant_reference_review_required",
          metadata: { source: "tenant_erasure" },
        },
        tx,
      );
      return { blocked: true as const, reason: "tenant_reference_review_required" };
    }
    await tx
      .update(tenantErasureStates)
      .set({
        lease_owner: leaseOwner,
        lease_expires_at: new Date(now() + LEASE_MS),
        attempts: state.attempts + 1,
        updated_at: new Date(now()),
      })
      .where(eq(tenantErasureStates.tenant_id, tenantId));
    await auditAwait(
      {
        tenant_id: tenantId,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.TENANT_UPDATED,
        resource_type: "tenant",
        resource_id: tenantId,
        result: "success",
        metadata: { source: "tenant_erasure", stage: "claimed", attempt: state.attempts + 1 },
      },
      tx,
    );
    return { blocked: false as const, state, tenant };
  });
  if (!claim) return { status: "skipped" as const };
  if (claim.blocked)
    return {
      status: "blocked" as const,
      reason: "reason" in claim ? claim.reason : "producer_drain_evidence_required",
    };
  let phase: "queue" | "objects" | "database" = "queue";
  const before = tenantWorkSnapshot(tenantId);
  try {
    const targetEvents = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.tenant_id, tenantId));
    const workspaces = await withTenantScope(db, tenantId, (tx) =>
      tx
        .select({ platform: chatWorkspaces.platform, workspace_id: chatWorkspaces.workspace_id })
        .from(chatWorkspaces)
        .where(eq(chatWorkspaces.tenant_id, tenantId)),
    );
    await eraseTenantQueueJobs(dependencies.queue, {
      tenant_id: tenantId,
      event_ids: targetEvents.map((event) => event.id),
      workspaces,
    });
    await releaseStoppedPendingHostedWork(tenantId, dependencies.queue, db);
    const snapshot = tenantWorkSnapshot(tenantId);
    if (snapshot.in_flight > 0 || (await listUnsettledHostedWork(tenantId, db)).length > 0)
      throw new TenantQueueDrainRequired();
    await checkpoint(tenantId, leaseOwner, "queue_cleared", db);
    phase = "objects";
    await assertHostedObjectErasureReady(tenantId, db);
    for (const prefix of [`${tenantId}/`, `offload/${tenantId}/`]) {
      const objects = await dependencies.objects.list(prefix);
      if (objects.some((object) => !object.key.startsWith(prefix)))
        throw new Error("tenant_erasure_object_boundary_mismatch");
      await dependencies.objects.deleteMany(objects.map((object) => object.key));
      if ((await dependencies.objects.list(prefix)).length > 0)
        throw new Error("tenant_erasure_objects_not_empty");
    }
    await checkpoint(tenantId, leaseOwner, "objects_cleared", db);
    phase = "database";
    await withTenantScope(db, tenantId, async (tx) => {
      const tenant = await dueTenant(tenantId, tx);
      if (!tenant) throw new Error("tenant_erasure_state_changed");
      const [state] = await tx
        .select()
        .from(tenantErasureStates)
        .where(
          and(
            eq(tenantErasureStates.tenant_id, tenantId),
            eq(tenantErasureStates.lease_owner, leaseOwner),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !state ||
        tenantWorkSnapshot(tenantId).in_flight > 0 ||
        (await listUnsettledHostedWork(tenantId, tx)).length > 0
      )
        throw new TenantQueueDrainRequired();
      await assertNoCrossTenantErasureReferences(tenantId, tx);
      const members = await tx
        .select({ identity_id: users.auth_identity_id })
        .from(users)
        .where(eq(users.tenant_id, tenantId));
      const identityIds = new Set(
        members.map((member) => member.identity_id).filter((id): id is string => id !== null),
      );
      if (tenant.owner_identity_id) identityIds.add(tenant.owner_identity_id);
      await markErasedHostedObjects(tenantId, dependencies.objects, tx);
      await eraseTenantRuntimeArtifacts(tenantId, tx);
      for (const name of order)
        await tx.execute(
          sql`DELETE FROM ${sql.identifier("subkit")}.${sql.identifier(name)} WHERE tenant_id=${tenantId}`,
        );
      for (const identityId of identityIds) {
        const [remaining] = await tx
          .select({ id: users.id })
          .from(users)
          .innerJoin(tenants, eq(tenants.id, users.tenant_id))
          .where(
            and(
              eq(users.auth_identity_id, identityId),
              eq(users.status, "active"),
              isNull(users.deleted_at),
              eq(tenants.status, "active"),
              isNull(tenants.deleted_at),
            ),
          )
          .limit(1);
        if (!remaining) {
          await tx
            .update(authIdentities)
            .set({ email: "", updated_at: new Date(now()) })
            .where(eq(authIdentities.id, identityId));
          await tx
            .delete(identityRecoverySessions)
            .where(eq(identityRecoverySessions.auth_identity_id, identityId));
        }
      }
      await tx
        .update(tenants)
        .set({
          display_name: "Deleted workspace",
          llm_primary: null,
          llm_fallback: null,
          egress_guard_mode: null,
          timezone: "UTC",
          deleted_at: new Date(now()),
          updated_at: new Date(now()),
        })
        .where(eq(tenants.id, tenantId));
      await tx
        .update(tenantErasureStates)
        .set({
          stage: "completed",
          completed_at: new Date(now()),
          lease_owner: null,
          lease_expires_at: null,
          failure_code: null,
          drain_boot_id: null,
          drain_untracked: false,
          updated_at: new Date(now()),
        })
        .where(eq(tenantErasureStates.tenant_id, tenantId));
      await auditAwait(
        {
          tenant_id: tenantId,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.TENANT_DELETED,
          resource_type: "tenant",
          resource_id: tenantId,
          result: "success",
          metadata: {
            source: "tenant_erasure",
            online_content_erased: true,
            retained: ["ownership_binding", "budget_ledger", "erasure_receipt"],
            external_backup_retention: "operator_policy",
          },
        },
        tx,
      );
    });
    forgetErasedTenantRuntimeConfig(tenantId);
    return { status: "completed" as const };
  } catch (error) {
    const drain = error instanceof TenantQueueDrainRequired;
    const snapshot = tenantWorkSnapshot(tenantId);
    const failure = drain
      ? "producer_drain_required"
      : phase === "queue"
        ? "queue_cleanup_failed"
        : phase === "objects"
          ? "object_cleanup_failed"
          : "database_cleanup_failed";
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(tenantErasureStates)
        .set({
          failure_code: failure,
          lease_owner: null,
          lease_expires_at: null,
          ...(drain
            ? {
                drain_boot_id: snapshot.boot_id,
                drain_untracked: before.in_flight === 0 && snapshot.in_flight === 0,
              }
            : {}),
          updated_at: new Date(now()),
        })
        .where(
          and(
            eq(tenantErasureStates.tenant_id, tenantId),
            eq(tenantErasureStates.lease_owner, leaseOwner),
          ),
        )
        .returning({ tenant_id: tenantErasureStates.tenant_id });
      if (!updated) return;
      await auditAwait(
        {
          tenant_id: tenantId,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.TENANT_UPDATED,
          resource_type: "tenant",
          resource_id: tenantId,
          result: "error",
          reason: failure,
          metadata: { source: "tenant_erasure" },
        },
        tx,
      );
    });
    return { status: "blocked" as const, reason: failure };
  }
}
