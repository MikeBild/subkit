import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { executionFixtures } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import {
  assertHostedObjectReadable,
  hostedObjectNamespace,
  reserveHostedObject,
  retainHostedObject,
} from "../storage/hosted-objects.ts";
import { getObjectStore } from "../storage/object-store.ts";
import { STEP_RESULT_DB_BYTES, STEP_RESULT_PREVIEW_BYTES } from "./timeouts.ts";

export interface OffloadResult {
  storage_uri: string | null;
  preview: string | null;
  size_bytes: number;
  sha256: string;
}

export interface OffloadRef {
  $offloaded: true;
  storage_uri: string;
  preview: string;
  size_bytes: number;
  sha256?: string;
}

export const OffloadRefSchema = z.object({
  $offloaded: z.literal(true),
  storage_uri: z.string(),
  preview: z.string(),
  size_bytes: z.number(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

export function redactStorageUri(storage_uri: string): string {
  const sep = storage_uri.indexOf("://");
  return sep > 0 ? `${storage_uri.slice(0, sep)}://…` : "…";
}

export class OffloadResolutionError extends Error {
  readonly code = "offload_resolution_failed";
  readonly storage_uri: string;
  constructor(storage_uri: string, detail: string) {
    super(`failed to resolve offloaded payload ${redactStorageUri(storage_uri)}: ${detail}`);
    this.name = "OffloadResolutionError";
    this.storage_uri = storage_uri;
  }
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, uri: string): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    return Promise.reject(new OffloadResolutionError(uri, "execution aborted during re-hydration"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new OffloadResolutionError(uri, "execution aborted during re-hydration"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function isOffloadRef(v: unknown): v is OffloadRef {
  return (
    v !== null &&
    typeof v === "object" &&
    (v as { $offloaded?: unknown }).$offloaded === true &&
    typeof (v as { storage_uri?: unknown }).storage_uri === "string"
  );
}

export async function resolveOffloaded(
  db: Db,
  tenant_id: string,
  ref: OffloadRef,
  signal?: AbortSignal,
): Promise<unknown> {
  const parsed = OffloadRefSchema.safeParse(ref);
  if (!parsed.success) {
    const rawUri =
      ref &&
      typeof ref === "object" &&
      typeof (ref as { storage_uri?: unknown }).storage_uri === "string"
        ? (ref as { storage_uri: string }).storage_uri
        : "";
    throw new OffloadResolutionError(rawUri, `malformed offload ref: ${parsed.error.message}`);
  }
  const uri = parsed.data.storage_uri;
  if (signal?.aborted) {
    throw new OffloadResolutionError(uri, "execution aborted before re-hydration");
  }
  if (uri.startsWith("fixture://")) {
    const id = uri.slice("fixture://".length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new OffloadResolutionError(uri, `invalid fixture id "${id}"`);
    }
    const rows = await db
      .select({ body: executionFixtures.body })
      .from(executionFixtures)
      .where(
        and(
          eq(executionFixtures.tenant_id, tenant_id),
          eq(executionFixtures.id, id),
          eq(executionFixtures.kind, "offload"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new OffloadResolutionError(uri, "offload fixture row not found for this tenant");
    }
    return row.body ?? null;
  }
  if (uri.startsWith("s3://")) {
    const withoutScheme = uri.slice("s3://".length);
    const slash = withoutScheme.indexOf("/");
    if (slash < 0) {
      throw new OffloadResolutionError(uri, "malformed s3 uri (no key component)");
    }
    const uriBucket = withoutScheme.slice(0, slash);
    const key = withoutScheme.slice(slash + 1);
    let configuredBucket = "";
    try {
      configuredBucket = getConfig().storage.object_store.bucket;
    } catch {
      if (process.env.NODE_ENV !== "production") configuredBucket = "test";
    }
    if (!configuredBucket && process.env.NODE_ENV !== "production") {
      configuredBucket = "test";
    }
    if (!configuredBucket) {
      throw new OffloadResolutionError(uri, "object storage is not configured");
    }
    if (uriBucket !== configuredBucket) {
      throw new OffloadResolutionError(
        uri,
        "s3 uri bucket does not match configured product bucket",
      );
    }
    try {
      if (!key.startsWith(`offload/${tenant_id}/`))
        throw new OffloadResolutionError(uri, "object key does not belong to this tenant");
      await assertHostedObjectReadable(tenant_id, key, db);
      const bytes = await raceAbort(getObjectStore().get(key), signal, uri);
      if (parsed.data.sha256) {
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== parsed.data.sha256) {
          throw new OffloadResolutionError(uri, "application SHA-256 mismatch");
        }
      }
      return JSON.parse(bytes.toString("utf8"));
    } catch (err) {
      if (err instanceof OffloadResolutionError) throw err;
      logger.error({
        module: "execution",
        action: "offload.resolve_failed",
        msg: "s3 offload re-hydration failed",
        storage_uri: uri,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw new OffloadResolutionError(uri, "s3 read failed");
    }
  }
  throw new OffloadResolutionError(uri, "unsupported storage uri scheme");
}

export function previewOf(value: unknown): string {
  const s = JSON.stringify(value) ?? "null";
  return s.length > STEP_RESULT_PREVIEW_BYTES ? s.slice(0, STEP_RESULT_PREVIEW_BYTES) : s;
}

export interface MaybeOffloadParams {
  tenant_id: string;
  execution_id: string;
  step_id?: string | null;
  result: unknown;
}

interface ObjectStoreOffloadConfig {
  bucket: string;
  keyPrefix: string;
}

export function _s3OffloadConfigForTests(): ObjectStoreOffloadConfig | null {
  return objectStoreOffloadConfig();
}

function objectStoreOffloadConfig(): ObjectStoreOffloadConfig | null {
  try {
    const bucket = getConfig().storage.object_store.bucket;
    return bucket ? { bucket, keyPrefix: "offload" } : null;
  } catch {
    return process.env.NODE_ENV !== "production" ? { bucket: "test", keyPrefix: "offload" } : null;
  }
}

async function writeToObjectStore(
  db: Db,
  cfg: ObjectStoreOffloadConfig,
  params: MaybeOffloadParams,
  serialized: string,
): Promise<string> {
  const id = randomUUID();
  const key = `${cfg.keyPrefix}/${params.tenant_id}/${params.execution_id}/${id}.json`;
  const body = Buffer.from(serialized, "utf8");
  const objects = getObjectStore();
  let namespace: string | undefined;
  try {
    namespace = hostedObjectNamespace();
  } catch {}
  const reservation = await reserveHostedObject(
    db,
    params.tenant_id,
    key,
    body.byteLength,
    namespace,
  );
  await objects.put(key, body);
  if (reservation) await retainHostedObject(db, params.tenant_id, reservation);
  return `s3://${cfg.bucket}/${key}`;
}

export async function maybeOffload(
  db: Db,
  params: MaybeOffloadParams & { execution_privacy?: "sensitive" | undefined },
): Promise<OffloadResult> {
  if (params.execution_privacy === "sensitive")
    return { storage_uri: null, preview: null, size_bytes: 0, sha256: "" };
  const serialized = JSON.stringify(params.result) ?? "null";
  const size = Buffer.byteLength(serialized, "utf8");
  const sha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
  if (size <= STEP_RESULT_DB_BYTES) {
    return { storage_uri: null, preview: null, size_bytes: size, sha256 };
  }

  const objectStoreConfig = objectStoreOffloadConfig();
  if (!objectStoreConfig) throw new Error("object storage is not configured for payload offload");
  const uri = await writeToObjectStore(db, objectStoreConfig, params, serialized);
  return {
    storage_uri: uri,
    preview: serialized.slice(0, STEP_RESULT_PREVIEW_BYTES),
    size_bytes: size,
    sha256,
  };
}
