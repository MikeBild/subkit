// Tenant-scoped file resolver.
//
// SPOOL_THRESHOLD_BYTES: files larger than this are buffered to a tmpfile
// before dispatch so the driver receives a seekable file-backed stream
// instead of an in-memory iterable. 50 MB is the size at which the spool
// cost is cheaper than re-buffering the iterable per consumer.
export const SPOOL_THRESHOLD_BYTES = 50 * 1024 * 1024;

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
import { ATTACHMENT_REFERENCE_PREFIX, findFileBySlug, parseFileReference } from "./slug.ts";

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
 * bytes during the cleanup-cron 7-day soft-delete grace window.
 */
export async function requireFileForTenant(
  db: Db,
  tenant_id: string,
  fid: string,
): Promise<FileRow> {
  // Wire format is `fid_<uuid>`; the DB column is `uuid`. Strip the
  // `fid_` prefix before the SELECT so a wire-format ref doesn't
  // miss against the typed column.
  const uuid = fid.startsWith("fid_") ? fid.slice("fid_".length) : fid;
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.tenant_id, tenant_id), eq(files.id, uuid)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new FileNotFoundError(fid);
  return row;
}

/** Storage-URI parser. New rows use `s3://`; legacy bridge imports may
 *  still carry `local://` or `memory://` locators while they are migrated. */
export function storageKey(storage_uri: string): string {
  // `memory://<key>` — legacy in-process journey-test fixtures.
  if (storage_uri.startsWith("memory://")) return storage_uri.slice("memory://".length);
  if (storage_uri.startsWith("local://")) {
    // Drop any query params from a legacy presign locator.
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
  /**
   * Whether an `@attachment:<slug>` leaf may name the tenant's live file of
   * that slug. A slug is a readable name anyone can guess, unlike a `fid_`
   * id, so only a reference a workflow author wrote into the definition is
   * trusted to name a file this way. Left out, a slug leaf is not found.
   */
  resolve_references?: boolean;
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
 * Resolve a single `fid` (wire format or bare UUID) to a `ResolvedFile`
 * leaf. Tenant-scoped via `requireFileForTenant`; cross-tenant fids
 * throw `FileNotFoundError`. The optional `cache` lets the LLM
 * file-context assembler share lookups across multiple sibling resolves
 * within the same turn without paying for repeated row reads.
 *
 * Prefer this helper over hand-crafting a `{ $file: fid }` ref and
 * routing it through `walkAndResolve` — the cast that pattern requires
 * is unsafe and obscures the call shape.
 */
export async function resolveSingleFid(
  db: Db,
  tenant_id: string,
  fid: string,
  cache?: Map<string, ResolvedFile>,
): Promise<ResolvedFile> {
  if (cache) {
    const cached = cache.get(fid);
    if (cached) return cached;
  }
  const row = await requireFileForTenant(db, tenant_id, fid);
  const resolved = resolvedFromRow(row);
  if (cache) cache.set(fid, resolved);
  return resolved;
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
async function requireFileByReference(ctx: ResolverContext, ref: string): Promise<FileRow> {
  const slug = ctx.resolve_references ? parseFileReference(ref) : null;
  const row = slug ? await findFileBySlug(ctx.db, ctx.tenant_id, slug) : null;
  if (!row) throw new FileNotFoundError(ref);
  return row;
}

export async function walkAndResolve<T>(
  value: T,
  ctx: ResolverContext,
  cache: Map<string, ResolvedFile>,
): Promise<T> {
  if (isFileRef(value)) {
    const fid = value.$file;
    const cached = cache.get(fid);
    if (cached) return cached as unknown as T;
    const row = fid.startsWith(ATTACHMENT_REFERENCE_PREFIX)
      ? await requireFileByReference(ctx, fid)
      : await requireFileForTenant(ctx.db, ctx.tenant_id, fid);
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
