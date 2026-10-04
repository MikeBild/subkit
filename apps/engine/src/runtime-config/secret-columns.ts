import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { runtimeSecretVersions } from "../db/schema/index.ts";

export const SECRET_VERSION_BASE_COLUMNS = {
  name: runtimeSecretVersions.name,
  version: runtimeSecretVersions.version,
  ciphertext: runtimeSecretVersions.ciphertext,
  iv: runtimeSecretVersions.iv,
  auth_tag: runtimeSecretVersions.auth_tag,
  created_by: runtimeSecretVersions.created_by,
  created_at: runtimeSecretVersions.created_at,
  revoked_at: runtimeSecretVersions.revoked_at,
};

export const SECRET_VERSION_PENDING_COLUMNS = {
  pending_since: runtimeSecretVersions.pending_since,
  prepared_by: runtimeSecretVersions.prepared_by,
  pending_bindings: runtimeSecretVersions.pending_bindings,
};

let detected = new WeakMap<object, Map<string, Promise<boolean>>>();

export function resetSecretColumnDetection(): void {
  detected = new WeakMap();
}

export function hasColumn(db: Executor, table: string, column: string): Promise<boolean> {
  let perDb = detected.get(db);
  if (!perDb) {
    perDb = new Map();
    detected.set(db, perDb);
  }
  const key = `${table}.${column}`;
  const cached = perDb.get(key);
  if (cached) return cached;
  const probe = db
    .execute(
      sql`SELECT 1 FROM information_schema.columns WHERE table_schema = 'subkit' AND table_name = ${table} AND column_name = ${column} LIMIT 1`,
    )
    .then((result) => {
      const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
      return Array.isArray(rows) ? rows.length > 0 : false;
    });
  perDb.set(key, probe);
  probe.catch(() => perDb?.delete(key));
  return probe;
}

export function hasPendingSecretColumns(db: Executor): Promise<boolean> {
  return hasColumn(db, "runtime_secret_versions", "pending_since");
}

export function hasCredentialConnectionColumn(db: Executor): Promise<boolean> {
  return hasColumn(db, "credentials", "connection_id");
}

export function hasCredentialAuthorityRevisionColumn(db: Executor): Promise<boolean> {
  return hasColumn(db, "credentials", "authority_revision");
}

export interface SecretVersionRow {
  name: string;
  version: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  auth_tag: Uint8Array;
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
  pending_since: Date | null;
  prepared_by: string | null;
  pending_bindings: string[] | null;
}

export async function secretVersionProjection(db: Executor): Promise<{
  columns: typeof SECRET_VERSION_BASE_COLUMNS & Partial<typeof SECRET_VERSION_PENDING_COLUMNS>;
  complete: (row: Record<string, unknown>) => SecretVersionRow;
}> {
  const withPending = await hasPendingSecretColumns(db);
  const columns = withPending
    ? { ...SECRET_VERSION_BASE_COLUMNS, ...SECRET_VERSION_PENDING_COLUMNS }
    : { ...SECRET_VERSION_BASE_COLUMNS };
  return {
    columns,
    complete: (row) =>
      ({
        pending_since: null,
        prepared_by: null,
        pending_bindings: null,
        ...row,
      }) as SecretVersionRow,
  };
}
