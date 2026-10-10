import { and, eq, isNull, sql } from "drizzle-orm";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Db } from "../db/client.ts";
import { files } from "../db/schema/index.ts";
import { retryTransient } from "../db/transient.ts";

export const ATTACHMENT_REFERENCE_PREFIX = "@attachment:";

export const FILE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const SLUG_BASE_MAX = 48;
const MAX_ATTEMPTS = 5;

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

export function fileReference(slug: string | null | undefined): string | null {
  return slug ? `${ATTACHMENT_REFERENCE_PREFIX}${slug}` : null;
}

export function parseFileReference(value: string): string | null {
  if (!value.startsWith(ATTACHMENT_REFERENCE_PREFIX)) return null;
  const slug = value.slice(ATTACHMENT_REFERENCE_PREFIX.length);
  return FILE_SLUG_RE.test(slug) ? slug : null;
}

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

async function withFreeSlug<T>(
  db: Db,
  tenant_id: string,
  filename: string,
  write: (tx: Db, slug: string) => Promise<T>,
): Promise<T> {
  return retryTransient(async () => {
    for (let attempt = 1; ; attempt++) {
      const slug = await nextFreeFileSlug(db, tenant_id, filename);
      try {
        return await db.transaction(async (tx) => {
          await lockCatalogVocabulary(tx, tenant_id);
          return write(tx as unknown as Db, slug);
        });
      } catch (err) {
        if (!isSlugConflict(err) || attempt >= MAX_ATTEMPTS) throw err;
      }
    }
  });
}

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

export async function reviveFileRow(
  db: Db,
  row: typeof files.$inferSelect,
): Promise<typeof files.$inferSelect> {
  if (row.slug) {
    try {
      const revived = await retryTransient(async () => {
        const [updated] = await db.transaction(async (tx) => {
          await lockCatalogVocabulary(tx, row.tenant_id);
          return tx
            .update(files)
            .set({ deleted_at: null, updated_at: new Date() })
            .where(and(eq(files.tenant_id, row.tenant_id), eq(files.id, row.id)))
            .returning();
        });
        return updated;
      });
      return revived ?? row;
    } catch (err) {
      if (!isSlugConflict(err)) throw err;
    }
  }
  return withFreeSlug(db, row.tenant_id, row.filename, async (tx, slug) => {
    const [revived] = await tx
      .update(files)
      .set({ deleted_at: null, slug, updated_at: new Date() })
      .where(and(eq(files.tenant_id, row.tenant_id), eq(files.id, row.id)))
      .returning();
    return revived ?? row;
  });
}

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
