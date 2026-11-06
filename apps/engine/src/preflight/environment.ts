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
import { runtimeStateColumns } from "../runtime-config/service.ts";
import { type ObjectStoreConfig, S3ObjectStore } from "../storage/object-store.ts";
import type { ObjectStoreBinding, PreflightEnvironment } from "./checks.ts";

export function secretAad(name: string, version: number): string {
  return `runtime-secret:${name}:${version}`;
}

const SECRET_REF = /^secret:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})\/([1-9][0-9]*)$/;

function truthy(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function objectStoreSeedFromEnv(
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

export async function objectStoreBindingFromDocument(
  document: Record<string, unknown> | null,
  resolveSecret: (name: string, version: number) => Promise<string>,
): Promise<ObjectStoreBinding | null> {
  if (document === null) return null;
  const storage = document.storage;
  if (storage === null || typeof storage !== "object") return null;
  const block = (storage as Record<string, unknown>).object_store;
  if (block === null || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;

  const plain = (key: string): string | null => {
    const value = b[key];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  const resolved = async (key: string): Promise<string | null> => {
    const value = plain(key);
    if (value === null) return null;
    const ref = SECRET_REF.exec(value);
    if (!ref) return value;
    return resolveSecret(ref[1]!, Number(ref[2]));
  };

  const endpoint = plain("endpoint");
  const region = plain("region");
  const bucket = plain("bucket");
  const access_key_id = await resolved("access_key_id");
  const secret_access_key = await resolved("secret_access_key");
  if (!endpoint || !region || !bucket || !access_key_id || !secret_access_key) return null;
  const session_token = await resolved("session_token");
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

export function isUndefinedTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 8; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "42P01") return true;
    if (typeof candidate.message === "string" && /does not exist/i.test(candidate.message))
      return true;
    current = candidate.cause;
  }
  return false;
}

export async function schemaAheadTags(db: Db): Promise<string[]> {
  let rows: Array<{ hash: string; tag: string | null }>;
  try {
    const result = (await db.execute(
      sql`SELECT hash, tag FROM "subkit"."__drizzle_migrations" ORDER BY id`,
    )) as unknown as { rows?: Array<{ hash: string; tag: string | null }> };
    rows = result.rows ?? [];
  } catch (error) {
    if (isUndefinedTable(error)) return [];
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

export async function activeSettingsDocument(db: Db): Promise<Record<string, unknown> | null> {
  try {
    // tenant-filter:exempt — the canonical active pointer is product-global.
    const [state] = await db
      .select(runtimeStateColumns)
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
    if (isUndefinedTable(error)) return null;
    throw error;
  }
}

export async function readSecretVersion(db: Db, name: string, version: number): Promise<void> {
  await readSecretValue(db, name, version);
}

async function readSecretValue(db: Db, name: string, version: number): Promise<string> {
  // tenant-filter:exempt — secret versions are product-global operator state.
  const [row] = await db
    .select({
      ciphertext: runtimeSecretVersions.ciphertext,
      iv: runtimeSecretVersions.iv,
      auth_tag: runtimeSecretVersions.auth_tag,
    })
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
  return decryptSecret(
    { ciphertext: row.ciphertext, iv: row.iv, auth_tag: row.auth_tag },
    secretAad(name, version),
  );
}

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

export function createPreflightEnvironment(db: Db, cfg: Config): PreflightEnvironment {
  return {
    masterKey: () => process.env.MASTER_KEY,
    databaseUrl: () => cfg.database.url,
    pingDatabase: async () => {
      await db.execute(sql`SELECT 1`);
    },
    schemaAheadTags: () => schemaAheadTags(db),
    activeSettingsDocument: () => activeSettingsDocument(db),
    objectStoreBinding: async (document) =>
      (await objectStoreBindingFromDocument(document, (name, version) =>
        readSecretValue(db, name, version),
      )) ?? objectStoreSeedFromEnv(),
    probeObjectStore,
    readSecretVersion: (name, version) => readSecretVersion(db, name, version),
  };
}
