// Tenant-scoped file resolver.
//
// Two pieces:
//
//   1. `requireFileForTenant(db, tenant_id, fid)` — the single
//      tenant-isolation chokepoint. Every consumer that wants the
//      bytes (or metadata) for a file id routes through here. A
//      cross-tenant fid throws `not_found`; the route layer maps that
//      to HTTP 404 so the existence of another tenant's file never
//      leaks.
//
//   2. `walkAndResolve(value, ctx, cache)` — async recursive replacer
//      that walks a JSON value and replaces every `{ "$file": "fid_..."
//      }` leaf with a `ResolvedFile`. Used by the step-runner before
//      dispatch (so connector drivers see `openRead`-able bodies, not
//      reference shapes) and by the conversation-attachments analyser.
//      The `cache` is per-call so a single step that mentions the same
//      fid in multiple places (e.g. body + multipart) only reads the
//      bytes once.

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { files } from "../db/schema/files.ts";
import { getObjectStore } from "../storage/object-store.ts";

export type FileRow = typeof files.$inferSelect;

export interface ResolvedFile {
  id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  /** Stream the bytes from the object store. Resolved lazily so a
   *  resolver call that only inspects metadata doesn't pull bytes. */
  openRead(): Promise<AsyncIterable<Uint8Array>>;
}

export class FileNotFoundError extends Error {
  readonly code = "file_not_found";
  constructor(fid: string) {
    super(`file ${fid} not found in this tenant`);
    this.name = "FileNotFoundError";
  }
}

/**
 * The tenant-isolation chokepoint. Returns the row when (tenant_id,
 * fid) match; throws `FileNotFoundError` otherwise. Soft-deleted rows
 * (`deleted_at IS NOT NULL`) are still returned on the read path so a
 * workflow run holding a `$file` ref mid-deletion can still see the
 * bytes (per the cleanup-cron grace, C15).
 */
export async function requireFileForTenant(
  db: Db,
  tenant_id: string,
  fid: string,
): Promise<FileRow> {
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.tenant_id, tenant_id), eq(files.id, fid)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new FileNotFoundError(fid);
  return row;
}

/** Storage-URI parser: extract the backend key from a `local://`,
 *  `s3://<bucket>/`, or `memory://` URI. */
function storageKey(storage_uri: string): string {
  // `memory://<key>` — legacy in-process journey-test fixtures.
  if (storage_uri.startsWith("memory://")) return storage_uri.slice("memory://".length);
  if (storage_uri.startsWith("local://")) {
    // Drop any query params (the LocalDiskObjectStore presign sentinel
    // carries `?expires_at=`); we never store presign params in the
    // canonical row, but be defensive.
    const q = storage_uri.indexOf("?");
    const tail =
      q >= 0 ? storage_uri.slice("local://".length, q) : storage_uri.slice("local://".length);
    return tail;
  }
  if (storage_uri.startsWith("s3://")) {
    // `s3://<bucket>/<key>` — drop the bucket; the object store
    // singleton already binds the bucket at construction.
    const rest = storage_uri.slice("s3://".length);
    const slash = rest.indexOf("/");
    return slash >= 0 ? rest.slice(slash + 1) : rest;
  }
  // Unknown scheme — assume it's already a bare key.
  return storage_uri;
}

/** Build a `ResolvedFile` from a row. `openRead` is bound lazily so a
 *  resolver call that only needs metadata never touches the object
 *  store. */
export function resolvedFromRow(row: FileRow): ResolvedFile {
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    async openRead() {
      const store = getObjectStore();
      return await store.openRead(storageKey(row.storage_uri));
    },
  };
}

export interface ResolverContext {
  db: Db;
  tenant_id: string;
}

interface FileRefLeaf {
  $file: string;
}

function isFileRef(value: unknown): value is FileRefLeaf {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "$file") return false;
  const fid = (value as Record<string, unknown>).$file;
  return typeof fid === "string" && fid.length > 0;
}

/**
 * Recursively walk `value`, replacing every `{ "$file": "fid_..." }`
 * leaf with the corresponding `ResolvedFile`. Non-ref leaves pass
 * through. `cache` is a per-call `Map` so the same fid mentioned
 * multiple times in one step input only hits the DB + object store
 * once. Cross-tenant fids throw `FileNotFoundError`; the caller
 * decides how to surface it (HTTP 404 for the routes, run failure for
 * the step runner).
 */
export async function walkAndResolve<T>(
  value: T,
  ctx: ResolverContext,
  cache: Map<string, ResolvedFile>,
): Promise<T> {
  if (isFileRef(value)) {
    const fid = value.$file;
    const cached = cache.get(fid);
    if (cached) return cached as unknown as T;
    const row = await requireFileForTenant(ctx.db, ctx.tenant_id, fid);
    const resolved = resolvedFromRow(row);
    cache.set(fid, resolved);
    return resolved as unknown as T;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = await walkAndResolve(value[i], ctx, cache);
    }
    return out as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      out[k] = await walkAndResolve(src[k], ctx, cache);
    }
    return out as unknown as T;
  }
  return value;
}
