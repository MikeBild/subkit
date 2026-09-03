// Reading `runtime_secret_versions` on a schema that may be one release old.
//
// The bootstrap preflight and the host commands (`--vault-check`,
// `--vault-set`, `--rewrap-master-key`) run BEFORE this release's migrations
// — that is their whole point. Release 6.29 added three columns to this
// table (`pending_since`, `prepared_by`, `pending_bindings`); a `select()`
// that names them fails on the previous schema with "column does not
// exist", and a preflight that crashes (exit 1) instead of answering (0 or
// 3) rolls a deploy back. So every read of this table on such a path uses
// the column list below, and the three newer columns are added only after
// `information_schema` has confirmed them, once per database handle.

import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { runtimeSecretVersions } from "../db/schema/index.ts";

/** The columns every release since the table exists has had. */
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

/** The columns 6.29 added for prepared versions. */
export const SECRET_VERSION_PENDING_COLUMNS = {
  pending_since: runtimeSecretVersions.pending_since,
  prepared_by: runtimeSecretVersions.prepared_by,
  pending_bindings: runtimeSecretVersions.pending_bindings,
};

let detected = new WeakMap<object, Map<string, Promise<boolean>>>();

/**
 * Forget every answer. Called after migrations ran in this process: the
 * preflight asked on the old schema, and the boot that follows must ask again.
 */
export function resetSecretColumnDetection(): void {
  detected = new WeakMap();
}

/**
 * Whether `table.column` exists on this database. Detected once per executor
 * and remembered; a transaction handle is its own executor and asks once
 * more, which is one cheap catalog read.
 */
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
      sql`SELECT 1 FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${column} LIMIT 1`,
    )
    .then((result) => {
      const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
      return Array.isArray(rows) ? rows.length > 0 : false;
    });
  perDb.set(key, probe);
  probe.catch(() => perDb?.delete(key));
  return probe;
}

/** Whether this database already carries the prepared-version columns (6.29). */
export function hasPendingSecretColumns(db: Executor): Promise<boolean> {
  return hasColumn(db, "runtime_secret_versions", "pending_since");
}

/**
 * Whether `credentials.connection_id` (6.29) exists. `upsertCredential` runs
 * inside data migrations and their proofs against the schema that preceded
 * 0048, so it may not name the column there.
 */
export function hasCredentialConnectionColumn(db: Executor): Promise<boolean> {
  return hasColumn(db, "credentials", "connection_id");
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

/**
 * A projection that reads on both schemas: the newer columns are selected
 * where they exist and reported as null where they do not — which is also
 * the truth, because a schema without them has no prepared versions.
 */
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
