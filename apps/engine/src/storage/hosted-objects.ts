import { and, eq } from "drizzle-orm";
import { getConfig } from "../config/loader.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Db, Executor } from "../db/client.ts";
import { hostedQuotaError } from "../db/hosted-quota-errors.ts";
import { hostedStorageObjects, tenants } from "../db/schema/index.ts";
import { lockActiveTenant } from "../identity/tenant-status.ts";
import { objectStoreNamespace } from "./backend.ts";
import type { ObjectStore } from "./object-store.ts";

export function hostedObjectNamespace(): string {
  return objectStoreNamespace(getConfig().storage);
}

export async function reserveHostedObject(
  db: Db,
  tenantId: string,
  key: string,
  bytes: number,
  namespace?: string,
): Promise<string | null> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("invalid_object_size");
  try {
    return await db.transaction(async (tx) => {
      const [tenant] = await tx
        .select({ origin: tenants.origin })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (!tenant) throw new Error("object_tenant_not_found");
      if (tenant.origin !== "self_service") return null;
      await lockCatalogVocabulary(tx, tenantId);
      await lockActiveTenant(tenantId, tx);
      const [row] = await tx
        .insert(hostedStorageObjects)
        .values({
          tenant_id: tenantId,
          storage_key: key,
          storage_namespace: namespace ?? hostedObjectNamespace(),
          declared_bytes: BigInt(bytes),
          state: "pending",
        })
        .returning({ id: hostedStorageObjects.id });
      if (!row) throw new Error("object_reservation_failed");
      return row.id;
    });
  } catch (error) {
    throw hostedQuotaError(error) ?? error;
  }
}

export async function retainHostedObject(
  db: Db,
  tenantId: string,
  reservationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, tenantId);
    const [row] = await tx
      .update(hostedStorageObjects)
      .set({ state: "retained", updated_at: new Date() })
      .where(
        and(
          eq(hostedStorageObjects.tenant_id, tenantId),
          eq(hostedStorageObjects.id, reservationId),
          eq(hostedStorageObjects.state, "pending"),
        ),
      )
      .returning({ id: hostedStorageObjects.id });
    if (!row) throw new Error("object_reservation_state_changed");
  });
}

export async function assertHostedObjectNamespace(tenantId: string, exec: Executor): Promise<void> {
  const rows = await exec
    .select({ namespace: hostedStorageObjects.storage_namespace })
    .from(hostedStorageObjects)
    .where(eq(hostedStorageObjects.tenant_id, tenantId));
  if (rows.length === 0) return;
  const namespace = hostedObjectNamespace();
  if (rows.some((row) => row.namespace !== namespace))
    throw new Error("object_storage_namespace_changed");
}

export async function assertHostedObjectErasureReady(
  tenantId: string,
  exec: Executor,
): Promise<void> {
  await assertHostedObjectNamespace(tenantId, exec);
  const [pending] = await exec
    .select({ id: hostedStorageObjects.id })
    .from(hostedStorageObjects)
    .where(
      and(eq(hostedStorageObjects.tenant_id, tenantId), eq(hostedStorageObjects.state, "pending")),
    )
    .limit(1);
  if (pending) throw new Error("object_upload_reconciliation_required");
}

export async function markErasedHostedObjects(
  tenantId: string,
  objects: ObjectStore,
  exec: Executor,
): Promise<void> {
  await assertHostedObjectErasureReady(tenantId, exec);
  const rows = await exec
    .select({ key: hostedStorageObjects.storage_key })
    .from(hostedStorageObjects)
    .where(eq(hostedStorageObjects.tenant_id, tenantId))
    .for("update");
  for (const row of rows) {
    if (await objects.head(row.key)) throw new Error("object_absence_not_verified");
  }
  await exec
    .update(hostedStorageObjects)
    .set({ state: "absence_verified", absence_verified_at: new Date(), updated_at: new Date() })
    .where(eq(hostedStorageObjects.tenant_id, tenantId));
}

export async function deleteRetainedHostedObject(
  db: Db,
  tenantId: string,
  reservationId: string,
  objects: ObjectStore,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, tenantId);
    const [row] = await tx
      .select()
      .from(hostedStorageObjects)
      .where(
        and(
          eq(hostedStorageObjects.tenant_id, tenantId),
          eq(hostedStorageObjects.id, reservationId),
        ),
      )
      .for("update");
    if (!row) return;
    if (row.state === "pending") throw new Error("object_upload_reconciliation_required");
    if (row.storage_namespace !== hostedObjectNamespace())
      throw new Error("object_storage_namespace_changed");
    await tx
      .update(hostedStorageObjects)
      .set({ state: "deleting", absence_verified_at: null, updated_at: new Date() })
      .where(eq(hostedStorageObjects.id, row.id));
    await objects.delete(row.storage_key);
    if (await objects.head(row.storage_key)) throw new Error("object_absence_not_verified");
    await tx
      .update(hostedStorageObjects)
      .set({ state: "absence_verified", absence_verified_at: new Date(), updated_at: new Date() })
      .where(eq(hostedStorageObjects.id, row.id));
    await tx.delete(hostedStorageObjects).where(eq(hostedStorageObjects.id, row.id));
  });
}

export async function assertHostedObjectReadable(
  tenantId: string,
  key: string,
  exec: Executor,
): Promise<void> {
  const [tenant] = await exec
    .select({ origin: tenants.origin })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new Error("object_tenant_not_found");
  if (tenant.origin !== "self_service") return;
  const [row] = await exec
    .select()
    .from(hostedStorageObjects)
    .where(
      and(eq(hostedStorageObjects.tenant_id, tenantId), eq(hostedStorageObjects.storage_key, key)),
    )
    .limit(1);
  if (row?.state !== "retained") throw new Error("object_reservation_unavailable");
  if (row.storage_namespace !== hostedObjectNamespace())
    throw new Error("object_storage_namespace_changed");
}
