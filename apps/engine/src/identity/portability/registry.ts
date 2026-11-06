import { and, desc, eq, isNull } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { files, packageInstallItems, packageInstalls } from "../../db/schema/index.ts";
import { storageKey } from "../../files/resolver.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import { PACKAGE_CONTENT_TYPE, PACKAGE_MAX_BYTES } from "./format.ts";

const ARCHIVE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  PACKAGE_CONTENT_TYPE,
  "application/zip",
  "application/x-zip-compressed",
]);

export class PackageArchiveNotFoundError extends Error {
  constructor() {
    super("package_archive_not_found");
  }
}

interface StoredPackageArchive {
  file_id: string;
  filename: string;
  sha256: string | null;
  bytes: Buffer;
}

export async function loadStoredPackageArchive(
  exec: Executor,
  tenant_id: string,
  file_id: string,
): Promise<StoredPackageArchive> {
  const [row] = await exec
    .select()
    .from(files)
    .where(and(eq(files.tenant_id, tenant_id), eq(files.id, file_id), isNull(files.deleted_at)))
    .limit(1);
  if (!row || !ARCHIVE_CONTENT_TYPES.has(row.content_type ?? "") || row.status !== "ready") {
    throw new PackageArchiveNotFoundError();
  }
  if (row.size_bytes > PACKAGE_MAX_BYTES) throw new PackageArchiveNotFoundError();
  const bytes = await getObjectStore().get(storageKey(row.storage_uri));
  return { file_id: row.id, filename: row.filename, sha256: row.sha256, bytes };
}

export async function markStoredPackageArchive(
  exec: Executor,
  tenant_id: string,
  file_id: string,
): Promise<typeof files.$inferSelect | null> {
  const [row] = await exec
    .update(files)
    .set({ content_type: PACKAGE_CONTENT_TYPE })
    .where(and(eq(files.tenant_id, tenant_id), eq(files.id, file_id)))
    .returning();
  return row ?? null;
}

export async function listPackageInstalls(exec: Executor, tenant_id: string) {
  return exec
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.tenant_id, tenant_id))
    .orderBy(desc(packageInstalls.created_at), desc(packageInstalls.id));
}

export async function getPackageInstall(exec: Executor, tenant_id: string, id: string) {
  const [install] = await exec
    .select()
    .from(packageInstalls)
    .where(and(eq(packageInstalls.tenant_id, tenant_id), eq(packageInstalls.id, id)))
    .limit(1);
  if (!install) return null;
  const items = await exec
    .select()
    .from(packageInstallItems)
    .where(
      and(eq(packageInstallItems.tenant_id, tenant_id), eq(packageInstallItems.install_id, id)),
    );
  return { install, items };
}
