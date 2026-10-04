export const SPOOL_THRESHOLD_BYTES = 50 * 1024 * 1024;

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
  openRead(): Promise<AsyncIterable<Uint8Array>>;
}

export class FileNotFoundError extends Error {
  readonly code = "file_not_found";
  constructor(fid: string) {
    super(`file ${fid} not found in this tenant`);
    this.name = "FileNotFoundError";
  }
}

export async function requireFileForTenant(
  db: Db,
  tenant_id: string,
  fid: string,
): Promise<FileRow> {
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

export function storageKey(storage_uri: string): string {
  if (storage_uri.startsWith("memory://")) return storage_uri.slice("memory://".length);
  if (storage_uri.startsWith("local://")) {
    const q = storage_uri.indexOf("?");
    const tail =
      q >= 0 ? storage_uri.slice("local://".length, q) : storage_uri.slice("local://".length);
    return tail;
  }
  if (storage_uri.startsWith("s3://")) {
    const rest = storage_uri.slice("s3://".length);
    const slash = rest.indexOf("/");
    return slash >= 0 ? rest.slice(slash + 1) : rest;
  }
  return storage_uri;
}

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
