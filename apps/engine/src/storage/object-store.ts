// Object-store abstraction for engine-managed binary uploads.
//
// One implementation per deployment backend (local disk, S3). Used by
// the unified files resource for every file the engine knows about —
// chat attachments, knowledge sources, workflow inputs/outputs,
// discovery archives. The interface is intentionally narrow: put / get
// / openRead / head / copy / presignPut / delete / exists.
//
// Selection is config-driven: `storage.files.backend ∈ {"local","s3"}`,
// with the S3 backend reusing the `storage.s3.*` credential block.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pipeline } from "node:stream/promises";
import { S3Client } from "@bradenmacdonald/s3-lite-client";
import { getConfig } from "../config/loader.ts";
import { envIntOr } from "../utils/env-config.ts";

export interface PresignedUpload {
  /** URL the client PUTs the bytes to. */
  url: string;
  /** Headers the client must send with the PUT. */
  headers: Record<string, string>;
  /** Seconds until the URL expires. */
  expires_in: number;
}

export interface ObjectHead {
  size: number;
  etag?: string;
}

export interface ObjectStore {
  /** Persist `body` at `key`. Overwrites if present. */
  put(key: string, body: Buffer | Uint8Array): Promise<void>;

  /** Persist a streamed body at `key`. Overwrites if present. The
   *  iterable is consumed exactly once; the caller is responsible for
   *  bounded-size enforcement (e.g. counting bytes inside a wrapping
   *  generator and aborting the producer). Local disk pipes through
   *  `fs.createWriteStream`; S3 hands the underlying ReadableStream
   *  straight to `putObject` so neither backend doubles peak memory. */
  putStream(key: string, body: AsyncIterable<Uint8Array>): Promise<void>;

  /** Fetch the bytes at `key`. Throws if not found. */
  get(key: string): Promise<Buffer>;

  /** Stream the bytes at `key`. Throws if not found. Backends must
   *  return an `AsyncIterable` that yields without buffering the whole
   *  object — large-file paths (LLM `text_extract`, multipart upload,
   *  Range download) depend on this. Delegates to `openReadRange` with
   *  no bounds; backends do not need to override. */
  openRead(key: string): Promise<AsyncIterable<Uint8Array>>;

  /** Stream a byte range at `key`. Both bounds are inclusive (HTTP
   *  Range semantics: `bytes=0-999` yields 1000 bytes). Omitting
   *  `start` reads from offset 0; omitting `end` reads to EOF. Throws
   *  if the key is missing.
   *
   *  Backends implement this so the HTTP content route can serve
   *  partial responses for multi-GB objects without buffering the full
   *  object in memory. */
  openReadRange(
    key: string,
    range: { start?: number; end?: number },
  ): Promise<AsyncIterable<Uint8Array>>;

  /** Server-side copy from `src` to `dst`. On local disk this is a
   *  file copy; on S3 it is `CopyObject`. */
  copy(src: string, dst: string): Promise<void>;

  /** Lightweight existence + size probe. Returns `null` when missing. */
  head(key: string): Promise<ObjectHead | null>;

  /** Issue a time-limited URL the client can PUT to. */
  presignPut(key: string, ttlSec: number): Promise<PresignedUpload>;

  /** Remove the object. No-op when missing. */
  delete(key: string): Promise<void>;

  /** Return true if the object exists. */
  exists(key: string): Promise<boolean>;
}

// ----- HMAC presign token (LocalDiskObjectStore.presignPut) -------------------

/**
 * HMAC token claims for the local-disk presign URL. Bound to a
 * (tenant_id, key, expires_at, size_bytes) tuple so a token leaks no
 * further than its owner's tenant scope AND cannot be replayed to PUT
 * arbitrarily-large bytes — the sink rejects 413 if the upload exceeds
 * the bound size. Signed with the engine instance secret
 * (`auth.session.secret`) so a single HMAC primitive guards every
 * engine-minted token — rotating the session secret rotates them all.
 *
 * `size_bytes` is the claim the client made at `batch-create` time.
 * Finalize still verifies sha256 (so a client that claims the right
 * size with the wrong bytes still fails), but bounding the upload
 * size up-front prevents the disk-fill / S3-cost amplification
 * vector where a rogue holder of a valid token streams gigabytes.
 */
export interface LocalPresignClaims {
  tenant_id: string;
  key: string;
  expires_at: number; // unix ms
  size_bytes: number;
}

function localPresignSecret(): string {
  // `auth.session.secret` is auto-generated to a 32-byte hex on first
  // boot (see schema.ts:259-265). It is the engine instance secret;
  // we reuse it here so we have one secret to rotate, not many.
  const s = getConfig().auth.session.secret;
  if (!s || s.length < 16) {
    throw new Error(
      "object-store: auth.session.secret is unset or too short; cannot mint local presign tokens",
    );
  }
  return s;
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function signLocalPresign(claims: LocalPresignClaims, secret: string): string {
  const payload = b64url(JSON.stringify(claims));
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

/** Mint a token authorising a single PUT against the local-disk
 *  presign sink. The verifier lives in `verifyLocalPresignToken` below
 *  and is called from the `/v1/files/{id}/upload` route handler. */
export function mintLocalPresignToken(claims: LocalPresignClaims): string {
  return signLocalPresign(claims, localPresignSecret());
}

export type VerifyLocalPresignResult =
  | { ok: true; claims: LocalPresignClaims }
  | { ok: false; reason: "malformed" | "signature_mismatch" | "expired" };

export type ParseLocalPresignClaimsResult =
  | { ok: true; claims: LocalPresignClaims }
  | { ok: false; reason: "malformed" | "signature_mismatch" | "expired" };

/** MAC-verify a local-presign token, decode the embedded claims, and
 *  check the expiry. Does NOT bind the claims to a `(tenant_id, key)`
 *  expectation — callers that need that match call
 *  `verifyLocalPresignToken` (which threads through here and then
 *  enforces the bind) or compare `claims.tenant_id` / `claims.key`
 *  themselves.
 *
 *  Use this variant when the caller wants to use `claims.tenant_id`
 *  as the SCOPE for a downstream DB read instead of comparing
 *  it post-hoc. Defense-in-depth: a cross-tenant query is never
 *  issued in the first place, so the tenant-filter audit gate
 *  passes without an exemption annotation. */
export function parseLocalPresignClaims(token: string): ParseLocalPresignClaimsResult {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected_mac = createHmac("sha256", localPresignSecret())
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected_mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  let claims: LocalPresignClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LocalPresignClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof claims.size_bytes !== "number" ||
    !Number.isFinite(claims.size_bytes) ||
    claims.size_bytes < 0 ||
    typeof claims.tenant_id !== "string" ||
    claims.tenant_id.length === 0 ||
    typeof claims.key !== "string" ||
    claims.key.length === 0
  ) {
    // A token minted before the size-bound rollout, a token whose
    // payload was tampered with, or one whose required fields are
    // missing. Fail closed — the HMAC over the payload also covers
    // these fields, so a stripped claim would have failed the mac
    // check above; this branch defends against an old token still
    // in flight at deploy time.
    return { ok: false, reason: "malformed" };
  }
  if (claims.expires_at < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}

/** Verify a local-presign token. Fails closed on any mismatch.
 *
 *  The HMAC binds `size_bytes` (per `LocalPresignClaims`); the caller
 *  is responsible for enforcing the size cap against the streamed body
 *  using `claims.size_bytes` from the success case. We do not take
 *  `size_bytes` as an `expected` field here because the body length
 *  is only known after the stream completes. */
export function verifyLocalPresignToken(
  token: string,
  expected: { tenant_id: string; key: string },
): VerifyLocalPresignResult {
  const parsed = parseLocalPresignClaims(token);
  if (!parsed.ok) return parsed;
  if (parsed.claims.tenant_id !== expected.tenant_id || parsed.claims.key !== expected.key) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return parsed;
}

// ----- LocalDiskObjectStore ---------------------------------------------------

/**
 * Disk-backed store. The presigned URL points at a sk-engine endpoint
 * the client PUTs through; the endpoint validates an HMAC token
 * (`verifyLocalPresignToken`) and forwards the body to `put(key,
 * body)`.
 *
 * Locator format: keys are arbitrary slash-separated paths. The store
 * sandboxes them under `storage.files.dir` (default
 * `${os.tmpdir()}/sk-files`). Path traversal (`..`) is rejected.
 */
export class LocalDiskObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root?: string) {
    if (root !== undefined && root.length > 0) {
      this.root = root;
    } else {
      // Resolved per-instance: the config snapshot is captured at
      // construction time. `getObjectStore()` (below) builds the
      // module-level singleton so a `setConfigKey` write to
      // `storage.files.dir` is picked up on the next boot.
      const configured = safeReadConfigFilesDir();
      this.root = configured && configured.length > 0 ? configured : join(tmpdir(), "sk-files");
    }
  }

  private resolveKey(key: string): string {
    if (!key || key.includes("..")) {
      throw new Error(`object-store: invalid key "${key}"`);
    }
    const target = resolvePath(this.root, key);
    if (!target.startsWith(resolvePath(this.root))) {
      throw new Error(`object-store: key escapes storage root: ${key}`);
    }
    return target;
  }

  async put(key: string, body: Buffer | Uint8Array): Promise<void> {
    const target = this.resolveKey(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async putStream(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    const target = this.resolveKey(key);
    await mkdir(dirname(target), { recursive: true });
    // `pipeline` consumes the async iterable into the write stream and
    // resolves only when the write tail has been flushed to disk. Errors
    // surface from either side as a rejected promise — the caller sees a
    // single failure surface rather than having to wire `'error'`
    // listeners on the raw stream.
    const out = createWriteStream(target);
    await pipeline(body, out);
  }

  async get(key: string): Promise<Buffer> {
    const target = this.resolveKey(key);
    return await readFile(target);
  }

  async openRead(key: string): Promise<AsyncIterable<Uint8Array>> {
    return this.openReadRange(key, {});
  }

  async openReadRange(
    key: string,
    range: { start?: number; end?: number },
  ): Promise<AsyncIterable<Uint8Array>> {
    const target = this.resolveKey(key);
    // `fs.createReadStream` natively supports inclusive `{ start, end }`
    // bounds — kernel-side `pread64` skips the unread head/tail without
    // ever paging it into the process.
    const opts: { start?: number; end?: number } = {};
    if (range.start !== undefined) opts.start = range.start;
    if (range.end !== undefined) opts.end = range.end;
    return createReadStream(target, opts) as unknown as AsyncIterable<Uint8Array>;
  }

  async copy(src: string, dst: string): Promise<void> {
    const data = await this.get(src);
    await this.put(dst, data);
  }

  async head(key: string): Promise<ObjectHead | null> {
    const target = this.resolveKey(key);
    try {
      const s = await stat(target);
      if (!s.isFile()) return null;
      return { size: s.size };
    } catch {
      return null;
    }
  }

  async presignPut(key: string, ttlSec: number): Promise<PresignedUpload> {
    // The disk store has no inherent URL surface — callers wire a sk-engine
    // route on top. We return a `local://` sentinel carrying an HMAC token
    // so the upload sink route can verify the PUT without touching the DB.
    const ttl = Math.max(60, Math.min(ttlSec, envIntOr("KNOWLEDGE_PRESIGN_MAX_TTL_SEC", 3600)));
    const expires_at = Date.now() + ttl * 1000;
    // The local sink route needs the tenant id to scope the key; it is
    // not known at this layer. Callers (the files HTTP route) compose
    // the URL themselves by appending the tenant prefix in their key
    // and minting via `mintLocalPresignToken` directly. The sentinel
    // returned here keeps the legacy callers working without tenant
    // scope — they get a bare token covering only the (key, expires_at)
    // and rely on the caller to fold tenant_id into the key path.
    return {
      url: `local://${key}?expires_at=${expires_at}`,
      headers: { "content-type": "application/octet-stream" },
      expires_in: ttl,
    };
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveKey(key);
    await rm(target, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    const target = this.resolveKey(key);
    try {
      const s = await stat(target);
      return s.isFile();
    } catch {
      return false;
    }
  }
}

// ----- S3ObjectStore ----------------------------------------------------------

/**
 * S3-backed object store, talking to any S3-compatible service via
 * `@bradenmacdonald/s3-lite-client`. The credential block lives at
 * `storage.s3.*` (shared with the connector driver), the bucket lives
 * at `storage.offload.bucket` is *not* used — engine-managed file
 * storage gets its own bucket via a separate config knob (operator
 * convention: the engine bucket is the `storage.s3.endpoint`'s default
 * bucket). For the v1 cut we read the bucket from the `storage.s3`
 * section via the `endpoint`-encoded bucket; if a future revision
 * adds an explicit `storage.files.bucket` knob, the constructor below
 * is the place to wire it.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
    region?: string;
    pathStyle?: boolean;
  }) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      endPoint: opts.endpoint,
      accessKey: opts.accessKey,
      secretKey: opts.secretKey,
      bucket: opts.bucket,
      region: opts.region ?? "us-east-1",
      pathStyle: opts.pathStyle ?? true,
    });
  }

  async put(key: string, body: Buffer | Uint8Array): Promise<void> {
    await this.client.putObject(key, body instanceof Buffer ? new Uint8Array(body) : body);
  }

  async putStream(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    // s3-lite-client's `putObject` accepts `ReadableStream<Uint8Array>`
    // directly (see node_modules/@bradenmacdonald/s3-lite-client/client.ts
    // around the streamOrData branch). Wrap the async iterable into a
    // ReadableStream so the client can drive its multipart machinery
    // without us buffering the whole body in process memory.
    const iterator = body[Symbol.asyncIterator]();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await iterator.next();
          if (done) {
            controller.close();
            return;
          }
          if (value) controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel(reason) {
        // Propagate cancellation to the source iterator if it supports it.
        if (typeof iterator.return === "function") {
          try {
            await iterator.return(reason);
          } catch {
            /* best-effort */
          }
        }
      },
    });
    await this.client.putObject(key, stream);
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.getObject(key);
    return Buffer.from(await res.arrayBuffer());
  }

  async openRead(key: string): Promise<AsyncIterable<Uint8Array>> {
    return this.openReadRange(key, {});
  }

  async openReadRange(
    key: string,
    range: { start?: number; end?: number },
  ): Promise<AsyncIterable<Uint8Array>> {
    // s3-lite-client exposes `getPartialObject({ offset, length })` which
    // emits the standard `Range: bytes=offset-(offset+length-1)` header
    // and forwards the 206 Partial Content body straight to the caller.
    // S3 + every S3-compatible vendor honour the same syntax.
    const hasRange = range.start !== undefined || range.end !== undefined;
    let res: Response;
    if (hasRange) {
      const offset = range.start ?? 0;
      // Inclusive end → length conversion. `length = 0` means "rest of
      // object from offset" per the client contract.
      const length = range.end !== undefined ? range.end - offset + 1 : 0;
      res = await this.client.getPartialObject(key, { offset, length });
    } else {
      res = await this.client.getObject(key);
    }
    if (!res.body) {
      return (async function* () {})();
    }
    return res.body as unknown as AsyncIterable<Uint8Array>;
  }

  async copy(src: string, dst: string): Promise<void> {
    await this.client.copyObject({ sourceBucketName: this.bucket, sourceKey: src }, dst);
  }

  async head(key: string): Promise<ObjectHead | null> {
    const exists = await this.client.exists(key);
    if (!exists) return null;
    const s = await this.client.statObject(key);
    return { size: s.size, etag: s.etag };
  }

  async presignPut(key: string, ttlSec: number): Promise<PresignedUpload> {
    const ttl = Math.max(60, Math.min(ttlSec, envIntOr("KNOWLEDGE_PRESIGN_MAX_TTL_SEC", 3600)));
    const url = await this.client.getPresignedUrl("PUT", key, { expirySeconds: ttl });
    return {
      url,
      headers: { "content-type": "application/octet-stream" },
      expires_in: ttl,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.deleteObject(key);
  }

  async exists(key: string): Promise<boolean> {
    return await this.client.exists(key);
  }
}

// ----- module-level singleton -------------------------------------------------

function safeReadConfigFilesDir(): string {
  try {
    return getConfig().storage.files.dir;
  } catch {
    // getConfig() throws if loadConfig() hasn't run. Tests that
    // construct LocalDiskObjectStore directly without booting the
    // config layer fall back to the tmpdir default.
    return "";
  }
}

let cached: ObjectStore | null = null;

/**
 * Resolve the configured object store. `storage.files.backend` selects
 * the implementation; the S3 backend pulls credentials from
 * `storage.s3.*`. The result is cached for the process lifetime; tests
 * reset via `setObjectStoreForTesting(null)`.
 */
export function getObjectStore(): ObjectStore {
  if (cached) return cached;
  // Resilient against tests that haven't bootstrapped the config loader.
  // Default to local-disk; production deployments always run loadConfig
  // at boot so the s3 branch fires correctly in real engines.
  let cfg: ReturnType<typeof getConfig>["storage"] | null = null;
  try {
    cfg = getConfig().storage;
  } catch {
    /* config not loaded — fall through to local-disk default */
  }
  const backend = cfg?.files.backend ?? "local";
  if (backend === "s3" && cfg) {
    // Cross-leaf invariant in `config/schema.ts` guarantees `bucket` is
    // non-empty when backend=s3 (rejected at config parse otherwise).
    cached = new S3ObjectStore({
      endpoint: cfg.s3.endpoint,
      accessKey: cfg.s3.access_key,
      secretKey: cfg.s3.secret_key,
      bucket: cfg.files.bucket,
    });
    return cached;
  }
  cached = new LocalDiskObjectStore();
  return cached;
}

/** Override for tests. Pass `null` to reset to env-driven default. */
export function setObjectStoreForTesting(store: ObjectStore | null): void {
  cached = store;
}
