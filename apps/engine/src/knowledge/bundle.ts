import type { RawChunk } from "../docs-ingestion/types.ts";
import { isStructuralTag } from "./tags.ts";

interface BundleFile {
  path: string;
  content: string;
}

interface ParsedBundle {
  chunks: RawChunk[];
  sourceTags: string[];
  skipped: string[];
}

const RESERVED_BASENAMES = new Set(["index.md", "log.md"]);

export function parseBundle(files: readonly BundleFile[]): ParsedBundle {
  const seen = new Set<string>();
  const chunks: RawChunk[] = [];
  const typeTags: string[] = [];
  const topicalTags: string[] = [];
  const skipped: string[] = [];

  const normalized = files
    .map((f) => ({ path: normalizeBundlePath(f.path), content: f.content }))
    .filter((f) => f.path !== "/")
    .sort((a, b) =>
      a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : a.content < b.content
            ? -1
            : a.content > b.content
              ? 1
              : 0,
    );

  for (const file of normalized) {
    if (seen.has(file.path)) {
      skipped.push(file.path);
      continue;
    }
    seen.add(file.path);

    const basename = file.path.slice(file.path.lastIndexOf("/") + 1).toLowerCase();
    if (RESERVED_BASENAMES.has(basename)) {
      skipped.push(file.path);
      continue;
    }

    const { fm } = extractFrontmatter(file.content);
    const fmTitle = typeof fm?.title === "string" ? fm.title.trim() : "";
    const title = fmTitle || basenameWithoutExtension(file.path);

    if (typeof fm?.type === "string" && fm.type.trim()) {
      const typeSlug = slugifyTagValue(fm.type);
      if (typeSlug) typeTags.push(`type:${typeSlug}`);
    }
    if (Array.isArray(fm?.tags)) {
      for (const t of fm.tags) {
        const tag = String(t).trim();
        if (tag && !isStructuralTag(tag)) topicalTags.push(tag);
      }
    }

    chunks.push({ title, path: file.path, content: file.content });
  }

  return { chunks, sourceTags: [...typeTags, ...topicalTags], skipped };
}

export function canonicalBundleSerialization(files: readonly BundleFile[]): string {
  const { chunks } = parseBundle(files);
  return JSON.stringify(chunks.map((c) => ({ path: c.path, content: c.content })));
}

export function extractFrontmatter(raw: string): {
  fm: Record<string, unknown> | null;
  body: string;
} {
  const input = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(input);
  if (!match) return { fm: null, body: input };
  const fm: Record<string, unknown> = {};
  const lines = match[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\s+$/, "");
    if (!line || line.startsWith("#") || /^\s/.test(line)) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    const rest = line.slice(idx + 1).trim();
    if (rest === "") {
      const items: string[] = [];
      while (i + 1 < lines.length) {
        const next = /^\s*-\s*(.+?)\s*$/.exec(lines[i + 1]!);
        if (!next) break;
        items.push(String(parseScalar(next[1]!)));
        i++;
      }
      fm[key] = items.length > 0 ? items : "";
      continue;
    }
    fm[key] = parseScalar(rest);
  }
  return { fm, body: (match[2] ?? "").trim() };
}

export function normalizeBundlePath(path: string): string {
  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== "." && s !== "..");
  return `/${segments.join("/")}`;
}

function basenameWithoutExtension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function slugifyTagValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 34);
}

function splitFlowList(inner: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && buf.trim() === "") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function parseScalar(raw: string): unknown {
  if (raw === "") return "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlowList(inner).map((s) => {
      const t = s.trim();
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1);
      }
      return t;
    });
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  if (!Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(raw)) return n;
  return raw;
}
