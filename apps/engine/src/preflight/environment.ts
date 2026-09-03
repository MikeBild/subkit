// The one production wiring of `PreflightEnvironment`.
//
// Kept apart from `checks.ts` so the checks stay testable with no process,
// no database and no S3, and so every read the preflight performs is
// visible in one file. Nothing here writes, with the single exception the
// contract asks for: check 3 puts one probe object and deletes it again.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Config } from "../config/schema.ts";
import { decryptSecret } from "../crypto/aes-gcm.ts";
import type { Db } from "../db/client.ts";
import { listEmbeddedMigrations } from "../db/migrate.ts";
import {
  runtimeConfigRevisions,
  runtimeConfigState,
  runtimeSecretVersions,
} from "../db/schema/index.ts";
import { CONFIG_STATE_KEY } from "../runtime-config/contracts.ts";
import { type ObjectStoreConfig, S3ObjectStore } from "../storage/object-store.ts";
import type { ObjectStoreBinding, PreflightEnvironment } from "./checks.ts";

/** The AAD every runtime secret version is bound to. Mirrors `runtime-config/service.ts`. */
export function secretAad(name: string, version: number): string {
  return `runtime-secret:${name}:${version}`;
}

function truthy(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

/**
 * The revision-1 environment seed, exactly as `config/loader.ts`
 * `collectBootstrapEnvSeeds()` reads it. Repeated here rather than
 * imported because the preflight must be able to answer check 3 whether or
 * not the loader has run, and because reading the seed is three lines while
 * depending on the loader's internals is a coupling.
 */
export function objectStoreSeedFromEnv(
  environment: Record<string, string | undefined> = process.env,
): ObjectStoreBinding | null {
  const endpoint = environment.OBJECT_STORAGE_ENDPOINT?.trim();
  const region = environment.OBJECT_STORAGE_REGION?.trim();
  const bucket = environment.OBJECT_STORAGE_BUCKET?.trim();
  const access_key_id = environment.OBJECT_STORAGE_ACCESS_KEY_ID?.trim();
  const secret_access_key = environment.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !region || !bucket || !access_key_id || !secret_access_key) return null;
  const session_token = environment.OBJECT_STORAGE_SESSION_TOKEN?.trim();
  const pathStyle =
    environment.OBJECT_STORAGE_PATH_STYLE ?? environment.OBJECT_STORAGE_FORCE_PATH_STYLE;
  return {
    endpoint,
    region,
    bucket,
    access_key_id,
    secret_access_key,
    ...(session_token ? { session_token } : {}),
    force_path_style: pathStyle === undefined ? true : truthy(pathStyle),
  };
}

/** The object-store block of a revision document, when it is complete. */
export function objectStoreBindingFromDocument(
  document: Record<string, unknown> | null,
): ObjectStoreBinding | null {
  if (document === null) return null;
  const storage = document.storage;
  if (storage === null || typeof storage !== "object") return null;
  const block = (storage as Record<string, unknown>).object_store;
  if (block === null || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  const str = (key: string): string | null => {
    const value = b[key];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  const endpoint = str("endpoint");
  const region = str("region");
  const bucket = str("bucket");
  const access_key_id = str("access_key_id");
  const secret_access_key = str("secret_access_key");
  // A secret leaf in a stored revision is a `secret://` reference, not a
  // usable value — the preflight cannot probe with it, so fall through to
  // the environment seed rather than pretend the binding is complete.
  if (!endpoint || !region || !bucket || !access_key_id || !secret_access_key) return null;
  if (secret_access_key.startsWith("secret://")) return null;
  const session_token = str("session_token");
  return {
    endpoint,
    region,
    bucket,
    access_key_id,
    secret_access_key,
    ...(session_token ? { session_token } : {}),
    force_path_style: b.force_path_style !== false,
  };
}

/**
 * Migration identities in the database that this binary does not carry.
 *
 * Read-only by construction: it queries the journal directly and treats an
 * undefined_table error (SQLSTATE 42P01) as a virgin database — the state
 * this release migrates forward from. Tagless rows are accepted pre-squash
 * history and are never "ahead" (see `db/migrate.ts` `detectDrift` for the
 * same identity rules; that function is deliberately NOT used here because
 * it creates the schema, the extension and the journal table).
 */
export async function schemaAheadTags(db: Db): Promise<string[]> {
  let rows: Array<{ hash: string; tag: string | null }>;
  try {
    const result = (await db.execute(
      sql`SELECT hash, tag FROM "subkit"."__drizzle_migrations" ORDER BY id`,
    )) as unknown as { rows?: Array<{ hash: string; tag: string | null }> };
    rows = result.rows ?? [];
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || /does not exist/i.test(String((error as Error).message))) return [];
    throw error;
  }
  const embedded = listEmbeddedMigrations();
  const byTag = new Map(embedded.map((m) => [m.tag, m.hash]));
  const byHash = new Map(embedded.map((m) => [m.hash, m.tag]));
  return rows
    .filter((r) => r.tag !== null)
    .filter((r) => byTag.get(r.tag!) !== r.hash || byHash.get(r.hash) !== r.tag)
    .map((r) => r.tag!);
}

/** The active revision's document, or null when no revision exists yet. */
export async function activeSettingsDocument(db: Db): Promise<Record<string, unknown> | null> {
  try {
    // tenant-filter:exempt — the canonical active pointer is product-global.
    const [state] = await db
      .select()
      .from(runtimeConfigState)
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
      .limit(1);
    if (!state?.active_revision) return null;
    // tenant-filter:exempt — revisions are product-global operator state.
    const [revision] = await db
      .select({ document: runtimeConfigRevisions.document })
      .from(runtimeConfigRevisions)
      .where(eq(runtimeConfigRevisions.revision, state.active_revision))
      .limit(1);
    return revision?.document ?? null;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || /does not exist/i.test(String((error as Error).message))) return null;
    throw error;
  }
}

/** Decrypt one stored version under the running MASTER_KEY. Throws when it cannot. */
export async function readSecretVersion(db: Db, name: string, version: number): Promise<void> {
  // tenant-filter:exempt — secret versions are product-global operator state.
  const [row] = await db
    .select()
    .from(runtimeSecretVersions)
    .where(
      and(
        eq(runtimeSecretVersions.name, name),
        eq(runtimeSecretVersions.version, version),
        isNull(runtimeSecretVersions.revoked_at),
      ),
    )
    .limit(1);
  if (!row) throw new Error("no such version, or it is revoked");
  decryptSecret(
    { ciphertext: row.ciphertext, iv: row.iv, auth_tag: row.auth_tag },
    secretAad(name, version),
  );
}

/**
 * Bucket reachable, and one probe object written and read back. The key
 * carries the pid so two simultaneous preflights cannot collide, and the
 * object is deleted in a `finally` so a failed read-back never leaves
 * litter behind.
 */
export async function probeObjectStore(binding: ObjectStoreBinding): Promise<void> {
  const store = new S3ObjectStore(binding as ObjectStoreConfig);
  await store.headBucket();
  const key = `.preflight/probe.${process.pid}`;
  const body = Buffer.from("subkit-preflight-probe", "utf8");
  try {
    await store.put(key, body);
    const back = await store.get(key);
    if (!back.equals(body)) throw new Error("probe object read back with unexpected content");
  } finally {
    await store.delete(key).catch(() => {});
  }
}

/**
 * Wire the checks against the live process. `cfg` is the config the loader
 * has just produced — its `database.url` is the real DSN, because the
 * bootstrap sentinel is only written into a stored revision.
 */
export function createPreflightEnvironment(db: Db, cfg: Config): PreflightEnvironment {
  return {
    masterKey: () => process.env.MASTER_KEY,
    databaseUrl: () => cfg.database.url,
    pingDatabase: async () => {
      await db.execute(sql`SELECT 1`);
    },
    schemaAheadTags: () => schemaAheadTags(db),
    activeSettingsDocument: () => activeSettingsDocument(db),
    objectStoreBinding: (document) =>
      objectStoreBindingFromDocument(document) ?? objectStoreSeedFromEnv(),
    probeObjectStore,
    readSecretVersion: (name, version) => readSecretVersion(db, name, version),
  };
}
