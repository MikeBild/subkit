// A stored file's human-readable reference: `@attachment:<slug>`.
//
// The slug is tenant-unique among live files (partial unique index
// `files_tenant_slug_uq`) and is chosen once, when the row is created. A
// rename or a content replacement keeps it, so a workflow or a message that
// names the file by its reference keeps finding it.
//
// `slugifyFilename` mirrors the backfill in migration 0077 exactly: a file
// that existed before the column did carries the slug this function would
// have chosen for it.

import { and, eq, isNull, sql } from "drizzle-orm";
import { toFileId } from "../api/files-schemas.ts";
import type { Db, Executor } from "../db/client.ts";
import { files } from "../db/schema/index.ts";

/** The reference prefix chat text and `$file` leaves use for a slug. */
export const ATTACHMENT_REFERENCE_PREFIX = "@attachment:";

/** A slug as the reference grammar accepts it. */
export const FILE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const SLUG_BASE_MAX = 48;
const MAX_ATTEMPTS = 5;

/** The slug a file name suggests: the name without its extension, umlauts
 *  spelled out, lowercased, every other run of characters a single `-`. */
export function slugifyFilename(filename: string): string {
  const stem = filename
    .replace(/\.[^.]*$/, "")
    .replace(/Ä/g, "ä")
    .replace(/Ö/g, "ö")
    .replace(/Ü/g, "ü")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, SLUG_BASE_MAX)
    .replace(/^[-_]+|[-_]+$/g, "");
  return stem.length > 0 ? stem : "file";
}

/** `@attachment:<slug>` for a slug, or null when the file has none. */
export function fileReference(slug: string | null | undefined): string | null {
  return slug ? `${ATTACHMENT_REFERENCE_PREFIX}${slug}` : null;
}

/** The slug named by an `@attachment:<slug>` reference, or null. */
export function parseFileReference(value: string): string | null {
  if (!value.startsWith(ATTACHMENT_REFERENCE_PREFIX)) return null;
  const slug = value.slice(ATTACHMENT_REFERENCE_PREFIX.length);
  return FILE_SLUG_RE.test(slug) ? slug : null;
}

/** The first free slug for `filename` in the tenant: the bare slug, else
 *  `<slug>-2`, `<slug>-3`, … */
export async function nextFreeFileSlug(
  db: Db,
  tenant_id: string,
  filename: string,
): Promise<string> {
  const base = slugifyFilename(filename);
  const taken = await db
    .select({ slug: files.slug })
    .from(files)
    .where(
      and(
        eq(files.tenant_id, tenant_id),
        isNull(files.deleted_at),
        sql`(${files.slug} = ${base} OR ${files.slug} LIKE ${`${base}-%`})`,
      ),
    );
  const used = new Set(taken.map((r) => r.slug));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

function isSlugConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  return msg.includes("files_tenant_slug_uq") || cause.includes("files_tenant_slug_uq");
}

/** Run `write` with a free slug, retrying when a concurrent write took it
 *  first. Each attempt runs in its own (nested) transaction so a conflict
 *  inside a caller's transaction does not poison it. */
async function withFreeSlug<T>(
  db: Db,
  tenant_id: string,
  filename: string,
  write: (tx: Db, slug: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const slug = await nextFreeFileSlug(db, tenant_id, filename);
    try {
      return await db.transaction(async (tx) => write(tx as unknown as Db, slug));
    } catch (err) {
      if (!isSlugConflict(err) || attempt >= MAX_ATTEMPTS) throw err;
    }
  }
}

/** The single way a `files` row comes into being: the row is inserted with
 *  a tenant-unique slug derived from its name. */
export async function insertFileRow(
  db: Db,
  values: Omit<typeof files.$inferInsert, "slug">,
): Promise<typeof files.$inferSelect> {
  return withFreeSlug(db, values.tenant_id, values.filename, async (tx, slug) => {
    const [row] = await tx
      .insert(files)
      .values({ ...values, slug })
      .returning();
    if (!row) throw new Error("files insert returned no row");
    return row;
  });
}

/** Bring a soft-deleted row back. It keeps its slug unless a live file took
 *  it meanwhile; then it gets the next free one. */
export async function reviveFileRow(
  db: Db,
  row: typeof files.$inferSelect,
): Promise<typeof files.$inferSelect> {
  if (row.slug) {
    try {
      const [revived] = await db.transaction(async (tx) =>
        tx
          .update(files)
          .set({ deleted_at: null, updated_at: new Date() })
          .where(eq(files.id, row.id))
          .returning(),
      );
      return revived ?? row;
    } catch (err) {
      if (!isSlugConflict(err)) throw err;
    }
  }
  return withFreeSlug(db, row.tenant_id, row.filename, async (tx, slug) => {
    const [revived] = await tx
      .update(files)
      .set({ deleted_at: null, slug, updated_at: new Date() })
      .where(eq(files.id, row.id))
      .returning();
    return revived ?? row;
  });
}

/** The live file a slug names in the tenant, or null. */
export async function findFileBySlug(
  db: Db,
  tenant_id: string,
  slug: string,
): Promise<typeof files.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.tenant_id, tenant_id), eq(files.slug, slug), isNull(files.deleted_at)))
    .limit(1);
  return row ?? null;
}

/**
 * A run's input, with every `{ "$file": "@attachment:<slug>" }` leaf pinned to
 * the `fid_` id the slug names right now.
 *
 * A slug is a name, and a name moves: delete a file and the next upload with
 * the same name takes its slug. A stored input that kept the slug would make
 * a later rerun read a different file than the run it repeats. Pinned when
 * the run is admitted, the input names one file for good. A slug that names
 * no live file is left as written; the step that reads it fails as before.
 * (A workflow definition keeps its references: resolving them anew is what
 * a reference is for.)
 */
export async function pinFileReferences(
  db: Executor,
  tenant_id: string,
  input: unknown,
): Promise<unknown> {
  const cache = new Map<string, string | null>();
  const walk = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(walk));
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const ref = record.$file;
    if (typeof ref === "string" && Object.keys(record).length === 1) {
      const slug = parseFileReference(ref);
      if (!slug) return value;
      if (!cache.has(slug)) {
        const row = await findFileBySlug(db as Db, tenant_id, slug);
        cache.set(slug, row ? toFileId(row.id) : null);
      }
      const fid = cache.get(slug);
      return fid ? { $file: fid } : value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) out[key] = await walk(child);
    return out;
  };
  return walk(input);
}
