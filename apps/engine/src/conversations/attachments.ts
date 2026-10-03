// Conversation attachment helpers — thin facade over the unified
// `files` + `file_links` resource.
//
// Two responsibilities live here, one for each surface:
//
//   1. Chat-text rewriter — `@attachment:<slug>` tokens that operators
//      type into conversation prose are converted into canonical
//      `{ "$file": "fid_<uuid>" }` JSON refs at message ingest. A slug
//      first names a file linked to the conversation; failing that, the
//      tenant's file carrying that slug (`files.slug`, the reference the
//      files page shows), which is then linked to the conversation.
//      `{ "$file": "@attachment:<slug>" }` leaves resolve through
//      `requireFileForTenant`.
//
//   2. JSON-tree resolver — re-exports `walkAndResolve` from
//      `files/resolver.ts` so existing callers (sdk-wrap invoke,
//      step-runner, conversation analysis) can keep importing from
//      `../attachments.ts` without a churn in import paths. The
//      canonical resolver lives under `files/`; this module is a
//      facade.
//
// Pre-unification this module owned an in-process MEMORY_STORE plus a
// dedicated `resolveAttachments(args)` walker that read the legacy
// `conversation_attachments` table. Both are gone — see migration 0019
// for the drop + the unified files routes for the replacement.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { toFileId } from "../api/files-schemas.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { fileLinks, files } from "../db/schema/index.ts";
import { parseFileReference } from "../files/slug.ts";
import { can } from "../rbac/index.ts";

export type { FileRow, ResolvedFile, ResolverContext } from "../files/resolver.ts";
export { FileNotFoundError, requireFileForTenant, walkAndResolve } from "../files/resolver.ts";

/** Legacy chat-text token grammar — kept identical to the
 *  pre-unification regex so prose authored before the rewrite still
 *  parses. The slug must be lowercase alphanumeric plus `_-`, between
 *  1 and 63 chars. */
export const ATTACHMENT_PREFIX = "@attachment:";
const ATTACHMENT_RE = /@attachment:([a-z0-9][a-z0-9_-]{0,62})\b/g;

export interface AttachmentSlugMatch {
  slug: string;
  span: { start: number; end: number };
  raw: string;
}

/** Scan a chat-text string for every `@attachment:<slug>` token.
 *  Returns the match offsets so callers can splice in the resolved
 *  reference shape without re-walking the string. */
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
  /**
   * Who wrote the text. A slug the conversation does not hold names a tenant
   * file only for someone who may read files (`file:read`): a slug is a
   * readable name anyone can guess, unlike a `fid_` id. `null` is a system
   * actor (trusted work); left out, the tenant is not searched at all.
   */
  principal?: ResolvedPrincipal | null;
}

/** Whether a slug the conversation does not hold may name a tenant file. */
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

/** Map every slug referenced in the conversation to the corresponding
 *  wire-format file id (`fid_<uuid>`). Unknown slugs are absent from
 *  the returned map — callers decide whether to fail or fall back. */
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

/** Load file rows for every slug referenced in the conversation. Used
 *  by the chat-text rewriter to surface filename / content_type when
 *  surfacing the resolved ref to downstream consumers (LLM context,
 *  message-multimodal builder). Unknown slugs are absent. */
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
  /** The input string with every resolved slug replaced by the
   *  canonical reference shape. */
  text: string;
  /** Slugs that appeared in the input but could not be resolved
   *  against `file_links`. Callers can surface this as a soft warning
   *  on the user turn; the literal `@attachment:<slug>` token stays in
   *  the text so the LLM can see what the user typed. */
  unresolved: string[];
  /** Resolved slug → file id (wire format) — used by the LLM-context
   *  layer to know which `$file` refs are in scope without re-parsing
   *  the rewritten text. */
  resolved: Array<{ slug: string; file_id: string }>;
}

/** The file id each slug names for this conversation and writer. The
 *  conversation's own links win; a slug they do not hold names the tenant's
 *  file under that slug — for a writer who may read files — which the
 *  conversation then holds too. Unknown slugs are absent. */
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

/**
 * A tool's arguments with every `{ "$file": "@attachment:<slug>" }` leaf
 * replaced by the `fid_` id it names, under the same rule chat text follows.
 * A slug the writer may not reach stays as written, and the resolver then
 * reports that file as not found.
 */
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

/**
 * Rewrite every `@attachment:<slug>` token in chat-text to the
 * canonical `{"$file":"fid_<uuid>"}` JSON-ref shape — encoded as the
 * literal sentinel `[file:fid_<uuid>]` inline so the surrounding text
 * stays human-readable. The chat-text pipeline (message ingest /
 * `buildUserContentParts`) consumes the sentinel to assemble
 * multimodal content parts.
 *
 * Unknown slugs are left in place so the LLM can see what the user
 * typed and ask a clarifying question on the next turn. The
 * `unresolved` array surfaces the same information to the caller.
 */
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
  // Walk back-to-front so splice offsets stay valid.
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
