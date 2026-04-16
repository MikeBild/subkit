// Markdown source normalizer.
//
// Accepts either a URL or a raw markdown string. Splits the document into
// one chunk per top-level heading (or per H2 if the doc opens with an H1,
// to keep chunks prompt-assembly friendly).
//
// We do a deliberately small amount of work here: no link resolution, no
// frontmatter stripping beyond the obvious `---...---` fence. The goal is
// a reasonable per-section slice that retrieval can search, not a
// full-blown markdown renderer.

import { assertPageSize, consumeBytes } from "../budgets.ts";
import { byteLen } from "../chunker.ts";
import type { BudgetState, RawChunk } from "../types.ts";

export interface MarkdownSourceInput {
  url?: string;
  content?: string;
}

export interface MarkdownIngestResult {
  uri: string;
  raw_bytes: number;
  chunks: RawChunk[];
}

export async function fetchMarkdown(
  input: MarkdownSourceInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ uri: string; body: string; bytes: number }> {
  if (input.content !== undefined) {
    const body = input.content;
    const bytes = byteLen(body);
    assertPageSize(bytes);
    return { uri: input.url ?? "inline://markdown", body, bytes };
  }
  if (!input.url) throw new Error("markdown source requires url or content");
  const res = await fetchImpl(input.url, { headers: { accept: "text/markdown,text/plain,*/*" } });
  if (!res.ok) throw new Error(`markdown fetch failed: ${res.status}`);
  const body = await res.text();
  const bytes = byteLen(body);
  assertPageSize(bytes);
  return { uri: input.url, body, bytes };
}

/** Strip a leading `---\n...\n---\n` YAML frontmatter block. */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith("---\n")) return md;
  const end = md.indexOf("\n---", 4);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\s*\n/, "");
}

/**
 * Split a markdown doc into per-section chunks using heading boundaries.
 * An "H1-only" doc falls back to splitting on H2 so we don't emit a
 * single monster chunk.
 */
export function chunkMarkdown(md: string): RawChunk[] {
  const clean = stripFrontmatter(md);
  const lines = clean.split("\n");
  // Find the shallowest heading level present; split on that level.
  let minLevel = Infinity;
  for (const line of lines) {
    const m = /^(#{1,6})\s+/.exec(line);
    if (m) minLevel = Math.min(minLevel, m[1]!.length);
  }
  // No headings at all — emit the whole body as a single chunk.
  if (!Number.isFinite(minLevel)) {
    return [{ title: null, path: null, content: clean.trim() }];
  }
  // If the file is a single top-level heading plus body, split one level
  // deeper so we get per-section chunks.
  let splitLevel = minLevel;
  const topLevelCount = lines.filter(
    (l) => /^(#{1,6})\s+/.exec(l)?.[1]?.length === minLevel,
  ).length;
  if (topLevelCount === 1 && minLevel < 6) splitLevel = minLevel + 1;

  const out: RawChunk[] = [];
  let currentTitle: string | null = null;
  let currentBuf: string[] = [];
  const pattern = new RegExp(`^#{${splitLevel}}\\s+(.*)$`);
  const flush = () => {
    const content = currentBuf.join("\n").trim();
    if (content.length > 0 || currentTitle) {
      out.push({
        title: currentTitle,
        path: currentTitle ? slugifyHeading(currentTitle) : null,
        content: currentTitle ? `${currentTitle}\n\n${content}` : content,
      });
    }
    currentBuf = [];
  };
  for (const line of lines) {
    const m = pattern.exec(line);
    if (m) {
      flush();
      currentTitle = m[1]!.trim();
      continue;
    }
    currentBuf.push(line);
  }
  flush();
  return out.length > 0 ? out : [{ title: null, path: null, content: clean.trim() }];
}

function slugifyHeading(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export async function ingestMarkdown(
  input: MarkdownSourceInput,
  state: BudgetState,
  fetchImpl: typeof fetch = fetch,
): Promise<MarkdownIngestResult> {
  const fetched = await fetchMarkdown(input, fetchImpl);
  consumeBytes(state, fetched.bytes);
  const chunks = chunkMarkdown(fetched.body);
  return { uri: fetched.uri, raw_bytes: fetched.bytes, chunks };
}
