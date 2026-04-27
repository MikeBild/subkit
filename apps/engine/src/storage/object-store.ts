// Object-store abstraction for engine-managed binary uploads.
//
// Used by the knowledge ingestion path (and, in a future revision, the
// connector-docs path) to persist large file uploads outside the
// pg-boss queue payload. Currently ships with a `LocalDiskObjectStore`;
// an `S3ObjectStore` is a planned follow-up that reuses the
// `@bradenmacdonald/s3-lite-client` already pulled in for the S3
// connector driver.
//
// The interface is intentionally narrow: put / get / presignPut /
// delete. We do not chase parity with S3's full surface — that's the
// connector driver's job. This abstraction exists so the engine itself
// has a place to store and retrieve binary uploads independently of any
// connector.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { envIntOr } from "../utils/env-config.ts";

export interface PresignedUpload {
  /** URL the client PUTs the bytes to. */
  url: string;
  /** Headers the client must send with the PUT. */
  headers: Record<string, string>;
  /** Seconds until the URL expires. */
  expires_in: number;
}

export interface ObjectStore {
  /** Persist `body` at `key`. Overwrites if present. */
  put(key: string, body: Buffer | Uint8Array): Promise<void>;

  /** Fetch the bytes at `key`. Throws if not found. */
  get(key: string): Promise<Buffer>;

  /** Issue a time-limited URL the client can PUT to. */
  presignPut(key: string, ttlSec: number): Promise<PresignedUpload>;

  /** Remove the object. No-op when missing. */
  delete(key: string): Promise<void>;

  /** Return true if the object exists. */
  exists(key: string): Promise<boolean>;
}

// ----- LocalDiskObjectStore ---------------------------------------------------

/**
 * Disk-backed store. The presigned URL points at a sk-engine endpoint
 * the client PUTs through; the endpoint validates an HMAC token and
 * forwards the body to `put(key, body)`. The endpoint is not wired in
 * this revision — for now `presignPut` returns a `local://` sentinel
 * URL that callers must resolve to a real upload route.
 *
 * Locator format: keys are arbitrary slash-separated paths. The store
 * sandboxes them under `KNOWLEDGE_STORAGE_DIR` (default
 * `${os.tmpdir()}/sk-knowledge`). Path traversal (`..`) is rejected.
 */
export class LocalDiskObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root?: string) {
    this.root = root ?? process.env.KNOWLEDGE_STORAGE_DIR ?? join(tmpdir(), "sk-knowledge");
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

  async get(key: string): Promise<Buffer> {
    const target = this.resolveKey(key);
    return await readFile(target);
  }

  async presignPut(key: string, ttlSec: number): Promise<PresignedUpload> {
    // The disk store has no inherent URL surface — callers wire a sk-engine
    // route on top. We return a `local://` sentinel so the caller can
    // detect "no remote presign" and substitute its own route.
    const _ttl = Math.max(60, Math.min(ttlSec, envIntOr("KNOWLEDGE_PRESIGN_MAX_TTL_SEC", 3600)));
    const expires_at = Date.now() + _ttl * 1000;
    return {
      url: `local://${key}?expires_at=${expires_at}`,
      headers: { "content-type": "application/octet-stream" },
      expires_in: _ttl,
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

// ----- module-level singleton -------------------------------------------------

let cached: ObjectStore | null = null;

/**
 * Resolve the configured object store. Currently only the local-disk
 * backend is wired; an S3 backend is a planned follow-up gated by
 * `KNOWLEDGE_STORAGE_BACKEND=s3` plus the standard AWS env vars.
 */
export function getObjectStore(): ObjectStore {
  if (cached) return cached;
  const backend = (process.env.KNOWLEDGE_STORAGE_BACKEND ?? "local").toLowerCase();
  if (backend === "s3") {
    throw new Error(
      "object-store: KNOWLEDGE_STORAGE_BACKEND=s3 is not yet implemented; use 'local' for now",
    );
  }
  cached = new LocalDiskObjectStore();
  return cached;
}

/** Override for tests. Pass `null` to reset to env-driven default. */
export function setObjectStoreForTesting(store: ObjectStore | null): void {
  cached = store;
}
