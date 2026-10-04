import { and, eq, inArray, isNull } from "drizzle-orm";
import { toFileId } from "../api/files-schemas.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { fileLinks, files } from "../db/schema/index.ts";
import { parseFileReference } from "../files/slug.ts";
import { can } from "../rbac/index.ts";

export type { FileRow, ResolvedFile, ResolverContext } from "../files/resolver.ts";
export { FileNotFoundError, requireFileForTenant, walkAndResolve } from "../files/resolver.ts";

export const ATTACHMENT_PREFIX = "@attachment:";
const ATTACHMENT_RE = /@attachment:([a-z0-9][a-z0-9_-]{0,62})\b/g;

export interface AttachmentSlugMatch {
  slug: string;
  span: { start: number; end: number };
  raw: string;
}

export function parseAttachmentSlugs(value: string): AttachmentSlugMatch[] {
  const out: AttachmentSlugMatch[] = [];
  for (let m = ATTACHMENT_RE.exec(value); m !== null; m = ATTACHMENT_RE.exec(value)) {
    const slug = m[1];
    if (!slug) continue;
    out.push({
      slug,
      span: { start: m.index, end: m.index + m[0].length },
      raw: m[0],
    });
  }
  ATTACHMENT_RE.lastIndex = 0;
  return out;
}

export interface SlugLookupCtx {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  principal?: ResolvedPrincipal | null;
}

async function mayReadTenantFiles(ctx: SlugLookupCtx): Promise<boolean> {
  if (ctx.principal === undefined) return false;
  if (ctx.principal === null) return true;
  const decision = await can(ctx.db as never, {
    tenant_id: ctx.tenant_id,
    principal: ctx.principal,
    permission: "file:read",
  });
  return decision.allow;
}

export async function lookupSlugsToFileIds(
  slugs: string[],
  ctx: SlugLookupCtx,
): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const rows = await ctx.db
    .select({ slug: fileLinks.slug, file_id: fileLinks.file_id })
    .from(fileLinks)
    .where(
      and(
        eq(fileLinks.tenant_id, ctx.tenant_id),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, ctx.conversation_id),
        inArray(fileLinks.slug, slugs),
      ),
    );
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.slug) out.set(r.slug, toFileId(r.file_id));
  }
  return out;
}

export async function lookupSlugsToFileRows(
  slugs: string[],
  ctx: SlugLookupCtx,
): Promise<Map<string, typeof files.$inferSelect>> {
  if (slugs.length === 0) return new Map();
  const rows = await ctx.db
    .select({
      slug: fileLinks.slug,
      file: files,
    })
    .from(fileLinks)
    .innerJoin(files, eq(files.id, fileLinks.file_id))
    .where(
      and(
        eq(fileLinks.tenant_id, ctx.tenant_id),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, ctx.conversation_id),
        inArray(fileLinks.slug, slugs),
      ),
    );
  const out = new Map<string, typeof files.$inferSelect>();
  for (const r of rows) {
    if (r.slug) out.set(r.slug, r.file);
  }
  return out;
}

export interface ChatTextRewriteResult {
  text: string;
  unresolved: string[];
  resolved: Array<{ slug: string; file_id: string }>;
}

async function slugsToFileIds(slugs: string[], ctx: SlugLookupCtx): Promise<Map<string, string>> {
  const map = await lookupSlugsToFileIds(slugs, ctx);
  const tenantSlugs = slugs.filter((slug) => !map.has(slug));
  if (tenantSlugs.length > 0 && (await mayReadTenantFiles(ctx))) {
    const tenantFiles = await ctx.db
      .select({ id: files.id, slug: files.slug })
      .from(files)
      .where(
        and(
          eq(files.tenant_id, ctx.tenant_id),
          inArray(files.slug, tenantSlugs),
          isNull(files.deleted_at),
        ),
      );
    for (const file of tenantFiles) {
      if (!file.slug) continue;
      await ctx.db
        .insert(fileLinks)
        .values({
          tenant_id: ctx.tenant_id,
          file_id: file.id,
          resource_type: "conversation",
          resource_id: ctx.conversation_id,
          slug: file.slug,
          role: "attachment",
        })
        .onConflictDoNothing();
      map.set(file.slug, toFileId(file.id));
    }
  }
  return map;
}

export async function resolveAttachmentSlugsInArgs<T>(value: T, ctx: SlugLookupCtx): Promise<T> {
  const slugs = new Set<string>();
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) collect(item);
      return;
    }
    if (v === null || typeof v !== "object") return;
    const ref = (v as Record<string, unknown>).$file;
    const slug = typeof ref === "string" ? parseFileReference(ref) : null;
    if (slug) slugs.add(slug);
    else for (const inner of Object.values(v)) collect(inner);
  };
  collect(value);
  if (slugs.size === 0) return value;
  const map = await slugsToFileIds([...slugs], ctx);
  const replace = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(replace);
    if (v === null || typeof v !== "object") return v;
    const record = v as Record<string, unknown>;
    const ref = record.$file;
    const slug = typeof ref === "string" ? parseFileReference(ref) : null;
    if (slug) {
      const fid = map.get(slug);
      return fid ? { ...record, $file: fid } : v;
    }
    return Object.fromEntries(Object.entries(record).map(([k, inner]) => [k, replace(inner)]));
  };
  return replace(value) as T;
}

export async function resolveAttachmentSlugsInText(
  text: string,
  ctx: SlugLookupCtx,
): Promise<ChatTextRewriteResult> {
  const matches = parseAttachmentSlugs(text);
  if (matches.length === 0) {
    return { text, unresolved: [], resolved: [] };
  }
  const distinctSlugs = [...new Set(matches.map((m) => m.slug))];
  const map = await slugsToFileIds(distinctSlugs, ctx);
  const unresolved: string[] = [];
  const resolved: Array<{ slug: string; file_id: string }> = [];
  const sorted = [...matches].sort((a, b) => b.span.start - a.span.start);
  let out = text;
  for (const match of sorted) {
    const fid = map.get(match.slug);
    if (!fid) {
      if (!unresolved.includes(match.slug)) unresolved.push(match.slug);
      continue;
    }
    if (!resolved.some((r) => r.slug === match.slug)) {
      resolved.push({ slug: match.slug, file_id: fid });
    }
    out = `${out.slice(0, match.span.start)}[file:${fid}]${out.slice(match.span.end)}`;
  }
  return { text: out, unresolved, resolved };
}
