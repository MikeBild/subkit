// Conversation file attachments.
//
// Operators upload files into a conversation (OpenAPI spec, CSV
// sample, operator notes, etc.); each file gets a stable `slug` the
// LLM can reference from any tool input as `@attachment:<slug>`.
//
// This module:
//
//   1. Parses `@attachment:<slug>` references out of arbitrary tool
//      arguments (strings, arrays, nested objects) — same walker shape
//      as the placeholder resolver in llm/substitution.
//   2. Resolves them against `conversation_attachments` by loading the
//      stored content (via storage_uri). A reference that is EXACTLY
//      `@attachment:<slug>` expands to the parsed content (JSON for
//      application/json, raw text otherwise). A reference embedded in
//      a longer string is replaced with the raw text form inline.
//   3. Returns the resolved value + a list of unresolved slugs so
//      callers (sdk-wrap) can fail the tool with a typed error.
//
// The resolver reads storage via a pluggable reader (see
// `readAttachmentContent`) so tests can drive in-memory payloads
// without wiring the S3/MinIO path.

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversationAttachments } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

export const ATTACHMENT_PREFIX = "@attachment:";
const ATTACHMENT_RE = /@attachment:([a-z0-9][a-z0-9_-]{0,62})\b/g;

export interface ResolverOptions {
  tenant_id: string;
  conversation_id: string;
  db: Db;
  /** Override the content reader — tests and non-S3 storage back-ends
   *  provide an in-memory or filesystem reader here. Defaults to
   *  `defaultContentReader` which only handles `file://` URIs. */
  read?: ContentReader;
}

export type ContentReader = (storage_uri: string) => Promise<string>;

export const defaultContentReader: ContentReader = async (uri) => {
  if (uri.startsWith("file://")) {
    const path = uri.slice("file://".length);
    return await Bun.file(path).text();
  }
  if (uri.startsWith("memory://")) {
    const key = uri.slice("memory://".length);
    const v = MEMORY_STORE.get(key);
    if (v === undefined) throw new Error(`memory attachment '${key}' not loaded`);
    return v;
  }
  throw new Error(`unsupported storage_uri scheme: ${uri.split("://")[0] ?? "(none)"}`);
};

/** In-memory content store used by tests. Writers call
 *  `putMemoryAttachment(key, content)` then point the DB row at
 *  `memory://<key>`. */
const MEMORY_STORE = new Map<string, string>();

export function putMemoryAttachment(key: string, content: string): void {
  MEMORY_STORE.set(key, content);
}

export function clearMemoryAttachments(): void {
  MEMORY_STORE.clear();
}

// ---------------------------------------------------------------------------
// Parse — pure string scan.

export interface AttachmentRef {
  slug: string;
  span: { start: number; end: number };
  raw: string;
  /** Whether the reference is the ENTIRE string (full replacement). */
  isStandalone: boolean;
}

export function parseAttachmentRefs(value: string): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  for (let m = ATTACHMENT_RE.exec(value); m !== null; m = ATTACHMENT_RE.exec(value)) {
    const slug = m[1];
    if (!slug) continue;
    const start = m.index;
    const end = start + m[0].length;
    out.push({
      slug,
      span: { start, end },
      raw: m[0],
      isStandalone: value.trim() === m[0],
    });
  }
  ATTACHMENT_RE.lastIndex = 0;
  return out;
}

/** Collect every distinct slug referenced anywhere inside a value. */
export function collectAttachmentSlugs(value: unknown): string[] {
  const acc = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const ref of parseAttachmentRefs(v)) acc.add(ref.slug);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v && typeof v === "object") {
      for (const inner of Object.values(v as Record<string, unknown>)) walk(inner);
    }
  };
  walk(value);
  return [...acc];
}

// ---------------------------------------------------------------------------
// Resolve — walks arbitrary structures.

export interface UnresolvedAttachment {
  slug: string;
  reason: "not_found" | "read_failed";
  message: string;
}

export interface ResolveResult<T> {
  value: T;
  unresolved: UnresolvedAttachment[];
  /** Slugs the walker actually substituted at least once. */
  slugs_used: string[];
}

interface ResolvedRow {
  slug: string;
  original_filename: string;
  content_type: string | null;
  raw: string;
  /** JSON-decoded form when content_type hints at JSON; else undefined. */
  parsed?: unknown;
}

async function loadResolvedRows(
  slugs: string[],
  opts: ResolverOptions,
): Promise<{
  rows: Map<string, ResolvedRow>;
  unresolved: UnresolvedAttachment[];
}> {
  if (slugs.length === 0) {
    return { rows: new Map(), unresolved: [] };
  }
  const dbRows = await opts.db
    .select()
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.tenant_id, opts.tenant_id),
        eq(conversationAttachments.conversation_id, opts.conversation_id),
        inArray(conversationAttachments.slug, slugs),
      ),
    );
  const found = new Map<string, ResolvedRow>();
  const unresolved: UnresolvedAttachment[] = [];
  const reader = opts.read ?? defaultContentReader;
  const seenSlugs = new Set(dbRows.map((r) => r.slug));
  for (const slug of slugs) {
    if (!seenSlugs.has(slug)) {
      unresolved.push({
        slug,
        reason: "not_found",
        message: `no attachment with slug '${slug}' on this conversation`,
      });
    }
  }
  for (const row of dbRows) {
    let raw: string;
    try {
      raw = await reader(row.storage_uri);
    } catch (err) {
      unresolved.push({
        slug: row.slug,
        reason: "read_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      logger.warn({
        module: "conversations.attachments",
        action: "resolve.read_failed",
        tenant_id: opts.tenant_id,
        slug: row.slug,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const ct = row.content_type ?? "";
    let parsed: unknown | undefined;
    if (ct.includes("application/json") || ct.includes("+json")) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
    }
    found.set(row.slug, {
      slug: row.slug,
      original_filename: row.original_filename,
      content_type: row.content_type,
      raw,
      ...(parsed !== undefined ? { parsed } : {}),
    });
  }
  return { rows: found, unresolved };
}

export async function resolveAttachments<T>(
  value: T,
  opts: ResolverOptions,
): Promise<ResolveResult<T>> {
  const slugs = collectAttachmentSlugs(value);
  if (slugs.length === 0) {
    return { value, unresolved: [], slugs_used: [] };
  }
  const { rows, unresolved } = await loadResolvedRows(slugs, opts);
  const slugs_used: string[] = [];

  const replaceString = (s: string): unknown => {
    const refs = parseAttachmentRefs(s);
    if (refs.length === 0) return s;
    // Single standalone reference — return the parsed JSON form if
    // available (the LLM usually wants the structured payload, not
    // the YAML/JSON text).
    const single = refs.length === 1 ? refs[0] : undefined;
    if (single?.isStandalone) {
      const row = rows.get(single.slug);
      if (!row) return s; // unresolved — keep the literal ref
      slugs_used.push(single.slug);
      return row.parsed ?? row.raw;
    }
    // Multiple or embedded refs — splice the raw text.
    const sorted = [...refs].sort((a, b) => b.span.start - a.span.start);
    let out = s;
    for (const ref of sorted) {
      const row = rows.get(ref.slug);
      if (!row) continue;
      slugs_used.push(ref.slug);
      out = out.slice(0, ref.span.start) + row.raw + out.slice(ref.span.end);
    }
    return out;
  };

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return replaceString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src)) out[k] = walk(src[k]);
      return out;
    }
    return v;
  };

  const value_out = walk(value) as T;
  return {
    value: value_out,
    unresolved,
    slugs_used: [...new Set(slugs_used)],
  };
}
