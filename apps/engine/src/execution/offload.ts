// Large-payload offload. When a serialized step result exceeds the
// threshold (10 KB), the engine writes it through the common immutable
// S3-compatible object-store adapter. Legacy fixture:// references remain
// readable during bridge migrations, but new writes never use PostgreSQL
// as a binary/blob fallback.
//
// A 512-byte text preview is always stored inline so operators can see
// at a glance what the payload looked like without resolving it.

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { executionFixtures } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { getObjectStore } from "../storage/object-store.ts";
import { STEP_RESULT_DB_BYTES, STEP_RESULT_PREVIEW_BYTES } from "./timeouts.ts";

export interface OffloadResult {
  // 'fixture://<uuid>' or 's3://<bucket>/<key>' or null if inline.
  storage_uri: string | null;
  preview: string | null; // truncated string preview if offloaded
  size_bytes: number;
  sha256: string;
}

/**
 * Execution-internal placeholder for a large payload that has ALREADY
 * been offloaded to durable storage (S3 or the `execution_fixtures`
 * table) by an upstream step. Substituted into the in-memory `scope`
 * in place of the full payload so a loop's `iterationResults` array
 * holds bounded references instead of N resident envelopes — the OOM
 * fix in `engine.ts`.
 *
 * INVARIANT: an `OffloadRef` is in-memory-only. It MUST be resolved
 * back to plain JSON via `resolveOffloaded` before the value crosses
 * ANY external surface — persisted execution result, validator input,
 * `data_selector` input, MCP/HTTP response. A persisted result that
 * still contains an `OffloadRef` is a contract violation.
 */
export interface OffloadRef {
  $offloaded: true;
  /** `fixture://<uuid>` or `s3://<bucket>/<key>` — the durable locator. */
  storage_uri: string;
  /** Inline `STEP_RESULT_PREVIEW_BYTES`-capped sample for diagnostics. */
  preview: string;
  /** Serialized byte size of the offloaded payload. */
  size_bytes: number;
  /** Application-owned payload digest; absent only on historical refs. */
  sha256?: string;
}

/**
 * Runtime parser for an `OffloadRef`. `isOffloadRef` is the cheap
 * structural guard for hot-path branching (the loop accumulator, the
 * preview collapse); `OffloadRefSchema` is the fail-fast boundary —
 * `resolveOffloaded` parses the incoming ref through it so a malformed
 * value (missing `preview` / `size_bytes`, a re-targeted shape) is
 * rejected with a typed error before any storage I/O runs.
 */
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

/**
 * Redact a `storage_uri` to its scheme only. A full offload locator is
 * `s3://<bucket>/<key>` or `fixture://<uuid>` — the bucket/key exposes
 * the offload backend layout, so the user-facing error `.message` must
 * never carry it. Operators get the full uri via the structured-log
 * `storage_uri` field (and `OffloadResolutionError.storage_uri`).
 *
 * Exported so every external-surface marker (error `.message`, the
 * `output_preview` offload marker in `offload-rehydrate.ts`) redacts a
 * locator identically — one helper, one redaction shape.
 */
export function redactStorageUri(storage_uri: string): string {
  const sep = storage_uri.indexOf("://");
  return sep > 0 ? `${storage_uri.slice(0, sep)}://…` : "…";
}

/** Typed failure raised when an `OffloadRef` cannot be re-hydrated.
 *  Never swallowed — re-hydration failure fails the consuming step.
 *
 *  `.message` carries only the REDACTED scheme (`s3://…` / `fixture://…`)
 *  so it is safe to surface in a REST/MCP error envelope. The full
 *  locator stays on `.storage_uri` — a non-message field — for operator
 *  log lines. */
export class OffloadResolutionError extends Error {
  readonly code = "offload_resolution_failed";
  readonly storage_uri: string;
  constructor(storage_uri: string, detail: string) {
    super(`failed to resolve offloaded payload ${redactStorageUri(storage_uri)}: ${detail}`);
    this.name = "OffloadResolutionError";
    this.storage_uri = storage_uri;
  }
}

/**
 * Race a promise against an `AbortSignal`. The s3-lite-client API takes
 * no signal, so a cancelled execution cannot interrupt the in-flight
 * `fetch`; this at least stops the engine from *awaiting* a multi-MB
 * GET / body read on an already-cancelled run. The underlying socket is
 * released by GC once the orphaned promise settles.
 */
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

/** Type guard for `OffloadRef`. */
export function isOffloadRef(v: unknown): v is OffloadRef {
  return (
    v !== null &&
    typeof v === "object" &&
    (v as { $offloaded?: unknown }).$offloaded === true &&
    typeof (v as { storage_uri?: unknown }).storage_uri === "string"
  );
}

/**
 * Re-hydrate an `OffloadRef` to the original payload.
 *
 * `fixture://<id>` → SELECT `body` from `execution_fixtures` filtered
 * by **both** `tenant_id` AND `id` — the tenant predicate is mandatory;
 * a cross-tenant read is the single highest isolation risk on this
 * path. `s3://<bucket>/<key>` → read through the common object-store
 * adapter.
 *
 * On a missing or unreadable ref this THROWS `OffloadResolutionError`
 * — it never returns `undefined`. A silent fallback would let a
 * truncated result reach a validator or the persisted execution
 * record.
 */
export async function resolveOffloaded(
  db: Db,
  tenant_id: string,
  ref: OffloadRef,
  signal?: AbortSignal,
): Promise<unknown> {
  // Fail-fast boundary: a malformed ref (missing preview/size_bytes, a
  // re-targeted shape) must never reach storage I/O. Parse through the
  // Zod schema and throw the typed `OffloadResolutionError` on failure.
  // The error `.message` carries only the REDACTED locator scheme, so a
  // best-effort `storage_uri` is recovered for redaction even when the
  // overall shape is invalid.
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
    // `body` is jsonb — drizzle returns the parsed value directly.
    return row.body ?? null;
  }
  if (uri.startsWith("s3://")) {
    // uri is `s3://<bucket>/<key>` — split scheme, bucket, key.
    const withoutScheme = uri.slice("s3://".length);
    const slash = withoutScheme.indexOf("/");
    if (slash < 0) {
      throw new OffloadResolutionError(uri, "malformed s3 uri (no key component)");
    }
    const uriBucket = withoutScheme.slice(0, slash);
    const key = withoutScheme.slice(slash + 1);
    // The bucket segment is authoritative: a uri that names a bucket
    // other than the configured product bucket is a re-target attempt
    // (or stale config) — fail with a typed error instead of silently
    // reading from `cfg.bucket` and returning the wrong object.
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
      // The raw S3 error can carry the bucket name, signed-URL fragments
      // or a request-id — none of which is safe on the user-facing
      // `.message`. Capture it in a structured log line only and throw a
      // fixed category string.
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

// Exported as `_s3OffloadConfigForTests` so the consumer read-back
// suite can verify the resolver reflects setConfigKey writes without
// a restart. Production code calls the unprefixed local binding via
// the closure inside maybeOffload below.
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
  cfg: ObjectStoreOffloadConfig,
  params: MaybeOffloadParams,
  serialized: string,
): Promise<string> {
  const id = randomUUID();
  const key = `${cfg.keyPrefix}/${params.tenant_id}/${params.execution_id}/${id}.json`;
  await getObjectStore().put(key, Buffer.from(serialized, "utf8"));
  return `s3://${cfg.bucket}/${key}`;
}

export async function maybeOffload(db: Db, params: MaybeOffloadParams): Promise<OffloadResult> {
  const serialized = JSON.stringify(params.result) ?? "null";
  const size = Buffer.byteLength(serialized, "utf8");
  const sha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
  if (size <= STEP_RESULT_DB_BYTES) {
    return { storage_uri: null, preview: null, size_bytes: size, sha256 };
  }

  void db;
  const objectStoreConfig = objectStoreOffloadConfig();
  if (!objectStoreConfig) throw new Error("object storage is not configured for payload offload");
  const uri = await writeToObjectStore(objectStoreConfig, params, serialized);
  return {
    storage_uri: uri,
    preview: serialized.slice(0, STEP_RESULT_PREVIEW_BYTES),
    size_bytes: size,
    sha256,
  };
}
