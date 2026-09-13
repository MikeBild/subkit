// Conversation attachment helpers — thin facade over the unified
// `files` + `file_links` resource.
//
// Two responsibilities live here, one for each surface:
//
//   1. Chat-text rewriter — `@attachment:<slug>` tokens that operators
//      type into conversation prose are converted into canonical
//      `{ "$file": "fid_<uuid>" }` JSON refs at message ingest. Slug
//      lookup is scoped to the conversation's `file_links` rows. This
//      is the ONLY surface that still accepts the legacy slug token;
//      everywhere else uses `$file` envelopes directly.
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

import { and, eq, inArray } from "drizzle-orm";

import { toFileId } from "../api/files-schemas.ts";
import type { Db } from "../db/client.ts";
import { fileLinks, files } from "../db/schema/index.ts";

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
  const map = await lookupSlugsToFileIds(distinctSlugs, ctx);
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
