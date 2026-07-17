// Knowledge-bundle parsing — a directory of markdown files posted as
// `[{path, content}]` becomes one Knowledge Source with one chunk per file.
//
// The format is deliberately tolerant and OKF-compatible by construction
// (okf.md v0.1: "If it has frontmatter with `type`, it's valid OKF"):
// frontmatter is optional, unknown keys are preserved verbatim because the
// chunk content keeps the raw file text INCLUDING the frontmatter block,
// and nothing is ever rejected — files without frontmatter are ingested as
// plain concepts. Only the two reserved navigation files (`index.md`,
// `log.md`, at any depth) are skipped: index duplicates concept titles
// (FTS noise) and log churn would rotate fingerprints on every re-import.
//
// Pure module — no DB, no IO. The service feeds the returned chunks into
// the existing fingerprint/dedup/insert pipeline (there is no third
// chunk-insert path; oversized files are split by `fingerprintChunks`).

import type { RawChunk } from "../docs-ingestion/types.ts";
import { isStructuralTag } from "./tags.ts";

export interface BundleFile {
  path: string;
  content: string;
}

export interface ParsedBundle {
  /** One chunk per non-reserved file, sorted by normalized path. */
  chunks: RawChunk[];
  /** Structural `type:<slug>` tags plus topical frontmatter tags, in
   *  first-seen path order. Caller merges + caps via `dedupeTags`. */
  sourceTags: string[];
  /** Normalized paths that were skipped (reserved files, duplicates). */
  skipped: string[];
}

/** Reserved navigation filenames (OKF v0.1 §6-7) — skipped at any depth. */
const RESERVED_BASENAMES = new Set(["index.md", "log.md"]);

/**
 * Parse a bundle into per-file chunks. Never throws on malformed input:
 * unparseable frontmatter simply yields no tags and the file is ingested
 * verbatim.
 */
export function parseBundle(files: readonly BundleFile[]): ParsedBundle {
  const seen = new Set<string>();
  const chunks: RawChunk[] = [];
  // Structural `type:*` tags come FIRST so the 20-tag `dedupeTags` cap can
  // never drop a routing key in favor of topical filler.
  const typeTags: string[] = [];
  const topicalTags: string[] = [];
  const skipped: string[] = [];

  // Tie-break equal normalized paths by content so duplicate spellings
  // (`a.md` vs `./a.md`) resolve to the SAME winner regardless of input
  // order — the version fingerprint must be deterministic across callers
  // whose JSON array order is not stable.
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
        // Frontmatter tags are UNTRUSTED content (a vault pulled from the
        // internet). Structural-shaped entries (`domain:payments`) would
        // mint routing keys that steer the agent briefing and tag-filtered
        // grounding — the same reason `mergeStructuralTags` drops
        // model-generated structural tags. Only the bounded `type:` mapping
        // above may mint structural tags from content; operator-supplied
        // input tags (CLI --tags) keep that authority.
        if (tag && !isStructuralTag(tag)) topicalTags.push(tag);
      }
    }

    chunks.push({ title, path: file.path, content: file.content });
  }

  return { chunks, sourceTags: [...typeTags, ...topicalTags], skipped };
}

/**
 * Stable serialization of a bundle — the persisted upload buffer and the
 * input to the source `version` fingerprint. Derived from `parseBundle` so
 * the fingerprint covers EXACTLY what gets ingested: sorted, duplicate
 * paths first-wins (matching the stored chunks), reserved files excluded
 * (a `log.md` append on an agent-maintained wiki must not rotate the
 * version and re-ingest identical content on every scheduled import).
 */
export function canonicalBundleSerialization(files: readonly BundleFile[]): string {
  const { chunks } = parseBundle(files);
  return JSON.stringify(chunks.map((c) => ({ path: c.path, content: c.content })));
}

/**
 * Tolerant frontmatter extraction: returns `fm: null` when the file has no
 * leading `---` block, and skips malformed lines instead of failing (the
 * seed parser in `seed.ts` is deliberately strict — wrong tolerance profile
 * for foreign bundles, so this one is separate).
 */
export function extractFrontmatter(raw: string): {
  fm: Record<string, unknown> | null;
  body: string;
} {
  // Windows editors save a BOM; without stripping it the `---` anchor
  // never matches and the file silently loses its tags.
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
      // YAML block sequence — both the indented (Obsidian) and the
      // zero-indent (Hugo/Jekyll/hand-written) layouts are valid YAML:
      //   tags:            tags:
      //     - runbook      - runbook
      // Zero-indent items never collide with the next mapping key: a
      // `key:` line does not start with `-`, so the lookahead stops there.
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

/** Bundle-relative path: forward slashes, no `.`/`..`/empty segments,
 *  leading `/` (the OKF-recommended stable link form). */
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

/** `BigQuery Table` → `bigquery-table` — tag values are routing keys, not prose. */
function slugifyTagValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 34);
}

/** Quote-aware comma split for `[a, "b, c", d]` flow lists — a naive
 *  `split(",")` tears quoted items apart and mints garbage tags. */
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
    // Only a LEADING quote opens a quoted scalar (YAML semantics) — a
    // mid-word apostrophe (`don't-panic`) is literal content, not quote
    // state, otherwise the rest of the list merges into one item.
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
