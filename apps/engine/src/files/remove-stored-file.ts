import { and, eq, type SQL } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Executor } from "../db/client.ts";
import { files } from "../db/schema/index.ts";
import { retryTransient } from "../db/transient.ts";
import { getObjectStore } from "../storage/object-store.ts";
import { storageKey } from "./resolver.ts";

export async function removeStoredFile(
  db: Executor,
  tenantId: string,
  fileId: string,
  eligible?: SQL,
  reason = "verified_object_cleanup",
): Promise<typeof files.$inferSelect | undefined> {
  return retryTransient(() =>
    db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, tenantId);
      const ownerTenantWhere = and(eq(files.tenant_id, tenantId), eq(files.id, fileId));
      const [locked] = await tx
        .select({ id: files.id })
        .from(files)
        .where(ownerTenantWhere)
        .for("update")
        .limit(1);
      if (!locked) return undefined;
      const tenantWhere = and(ownerTenantWhere, eligible);
      const [row] = await tx.select().from(files).where(tenantWhere).limit(1);
      if (!row) return undefined;
      const store = getObjectStore();
      const key = storageKey(row.storage_uri);
      await store.delete(key);
      if (await store.head(key))
        throw new Error("Object deletion could not be verified; file reservation retained");
      await tx.delete(files).where(tenantWhere);
      await auditAwait(
        {
          tenant_id: tenantId,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.FILE_DELETED,
          resource_type: "file",
          resource_id: row.id,
          result: "success",
          metadata: { file_id: row.id, reason },
        },
        tx,
      );
      return row;
    }),
  );
}
