import { assertPageSize, consumeBytes } from "../budgets.ts";
import { byteLen } from "../chunker.ts";
import { readBoundedText } from "../read-response.ts";
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
  const body = await readBoundedText(res);
  const bytes = byteLen(body);
  assertPageSize(bytes);
  return { uri: input.url, body, bytes };
}

export function stripFrontmatter(md: string): string {
  if (!md.startsWith("---\n")) return md;
  const end = md.indexOf("\n---", 4);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\s*\n/, "");
}

export function chunkMarkdown(md: string): RawChunk[] {
  const clean = stripFrontmatter(md);
  const lines = clean.split("\n");
  let minLevel = Infinity;
  for (const line of lines) {
    const m = /^(#{1,6})\s+/.exec(line);
    const hashes = m?.[1];
    if (hashes) minLevel = Math.min(minLevel, hashes.length);
  }
  if (!Number.isFinite(minLevel)) {
    return [{ title: null, path: null, content: clean.trim() }];
  }
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
    const title = m?.[1];
    if (title !== undefined) {
      flush();
      currentTitle = title.trim();
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
