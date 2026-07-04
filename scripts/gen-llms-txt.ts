// Generate docs/llms.txt, docs/llms-full.txt, and docs/llms-manifest.json for
// LLMs (see llmstxt.org).
//
// All three walk docs/**/*.md (excluding docs/internal/ and docs/_tapes/) in
// the same audience-then-path order, so they stay in lockstep:
//
//   docs/llms.txt          — a robots.txt-style index rendered by the SHARED
//                            renderer (@shared/llms-index renderLlmsIndex): an
//                            H1, a `>` blockquote lede, then a Markdown list
//                            grouped by audience, each entry
//                              - [Title](relative/path.md): one-line summary
//                            plus a final `## Optional` section for the
//                            auto-generated reference pages. Links here are
//                            repo-relative (the `docs/` prefix stripped) so
//                            they resolve under docs/ in GitHub AND against the
//                            origin over HTTP.
//
//   docs/llms-full.txt     — the full-content variant: an H1, a `>` blockquote
//                            with a relative back-link to the index, then every
//                            indexed page's complete Markdown concatenated
//                            inline, each preceded by a
//                            `<!-- Source: docs/path.md -->` marker, so a model
//                            can ground itself on the whole docs set in one
//                            fetch.
//
//   docs/llms-manifest.json — `{ pages: LlmsPage[] }`, the structured index
//                            (audience/path/title/summary, no content). Embedded
//                            into the engine so its /llms.txt route renders the
//                            SAME index with self-hosted origin links.
//
// Output is byte-stable: audiences in AUDIENCE_ORDER, entries sorted by path
// within each audience (README first). No timestamps, no absolute paths.
//
// Wired into `bun run verify` as a docs drift gate (see package.json:
// gen:llms-txt / check:llms-txt-drift), mirroring the settings-doc gate.
//
// Usage:
//   bun run scripts/gen-llms-txt.ts

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type LlmsPage, OPTIONAL_PATHS, renderLlmsIndex } from "@shared/llms-index.ts";

const DOCS_DIR = "docs";
const OUTPUT = join(DOCS_DIR, "llms.txt");
const OUTPUT_FULL = join(DOCS_DIR, "llms-full.txt");
const OUTPUT_MANIFEST = join(DOCS_DIR, "llms-manifest.json");
const EXCLUDE_DIRS = new Set(["internal", "_tapes"]);

// Audience folder -> section heading, in emission order.
const AUDIENCE_ORDER: ReadonlyArray<{ dir: string; label: string }> = [
  { dir: "concepts", label: "Concepts" },
  { dir: "operators", label: "Operators" },
  { dir: "authors", label: "Authors" },
  { dir: "developers", label: "Developers" },
  { dir: "admins", label: "Admins" },
];

interface Entry extends LlmsPage {
  content: string; // full, verbatim Markdown body
}

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      out.push(...walkMarkdown(full));
    } else if (name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function extractTitle(content: string): string | null {
  for (const raw of content.split("\n")) {
    const m = raw.match(/^#\s+(.+?)\s*#*\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}

function stripInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/`([^`]*)`/g, "$1") // inline code -> contents
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/__([^_]+)__/g, "$1") // bold
    .replace(/\*([^*]+)\*/g, "$1") // italic
    .replace(/<[^>]+>/g, "") // stray html tags
    .replace(/\s+/g, " ")
    .trim();
}

function extractSummary(content: string): string {
  const lines = content.split("\n");
  let inFence = false;
  let inComment = false;
  const paragraph: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    // Multi-line HTML comments (e.g. the auto-generated banner).
    if (inComment) {
      if (trimmed.includes("-->")) inComment = false;
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) inComment = true;
      continue;
    }

    // Fenced code / mermaid blocks.
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      if (paragraph.length > 0) break;
      continue;
    }
    if (inFence) continue;

    const isProse =
      trimmed.length > 0 &&
      !trimmed.startsWith("#") && // headings
      !trimmed.startsWith(">") && // blockquotes (reading-time/audience banners)
      !trimmed.startsWith("|") && // table rows
      !trimmed.startsWith("![") && // images
      !/^[-*+]\s/.test(trimmed) && // list items
      !/^\d+\.\s/.test(trimmed) && // ordered list
      !/^[-=]{3,}\s*$/.test(trimmed) && // horizontal rules / setext underline
      !/^<\/?[a-z]/i.test(trimmed); // raw html blocks

    if (isProse) {
      paragraph.push(trimmed);
      continue;
    }

    // A boundary line: if we already collected prose, the paragraph is done.
    if (paragraph.length > 0) break;
  }

  const joined = stripInline(paragraph.join(" "));
  if (!joined) return "";

  // First sentence: up to the first sentence-terminator followed by space/end.
  const sentence = joined.match(/^(.*?[.!?])(?:\s|$)/);
  return (sentence ? sentence[1] : joined).trim();
}

function main(): void {
  const files = walkMarkdown(DOCS_DIR);
  const entries: Entry[] = [];

  for (const file of files) {
    const rel = relative(".", file).split("\\").join("/");
    const segments = rel.split("/");
    // segments[0] === "docs"; audience is the next path segment.
    const audience = segments.length >= 3 ? segments[1] : "";
    if (!AUDIENCE_ORDER.some((a) => a.dir === audience)) continue;

    const content = readFileSync(file, "utf8");
    const title = extractTitle(content);
    if (!title) continue;
    entries.push({
      audience,
      path: rel,
      title,
      summary: extractSummary(content),
      content,
    });
  }

  // Deterministic order (audience, README-first, path) — `walkMarkdown` returns
  // `readdirSync` order, which differs across filesystems (macOS vs CI Linux).
  // The index/full outputs re-sort per audience, but the manifest emits `pages`
  // verbatim, so without this its array order — and thus the byte output — drifts
  // between environments and fails the drift gate.
  const audienceRank = (a: string): number => AUDIENCE_ORDER.findIndex((x) => x.dir === a);
  entries.sort((a, b) => {
    const ar = audienceRank(a.audience) - audienceRank(b.audience);
    if (ar !== 0) return ar;
    const aReadme = a.path.endsWith("/README.md");
    const bReadme = b.path.endsWith("/README.md");
    if (aReadme !== bReadme) return aReadme ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  // Strip content for the shared renderer + the manifest — both carry only the
  // structured index, never the full body.
  const pages: LlmsPage[] = entries.map(({ content: _content, ...page }) => page);

  // The index (llms.txt): rendered by the SHARED renderer with repo-relative
  // links (the `docs/` prefix stripped) so they resolve under docs/ in GitHub
  // AND against the origin over HTTP.
  const index = renderLlmsIndex(pages, {
    linkFor: (p) => p.path.replace(/^docs\//, ""),
    fullUrl: "llms-full.txt",
    optional: (p) => OPTIONAL_PATHS.has(p.path),
  });

  // The full text (llms-full.txt): H1, a `>` blockquote with a relative
  // back-link, then every page's complete Markdown inline.
  const fullLines: string[] = [
    "# sk Documentation — Full Text",
    "",
    "> The complete sk documentation set for LLMs in a single file: every public page's full Markdown, grouped by audience, each preceded by a source marker.",
    "> For the index see [llms.txt](llms.txt).",
  ];

  for (const { dir } of AUDIENCE_ORDER) {
    const group = entries
      .filter((e) => e.audience === dir)
      .sort((a, b) => {
        const ar = a.path.endsWith("/README.md");
        const br = b.path.endsWith("/README.md");
        if (ar !== br) return ar ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
    for (const e of group) {
      // Source marker + verbatim body; trailing whitespace trimmed so the
      // separator spacing is identical regardless of how each file ends.
      fullLines.push("", `<!-- Source: ${e.path} -->`, "", e.content.trimEnd());
    }
  }

  writeFileSync(OUTPUT, `${index}\n`);
  writeFileSync(OUTPUT_FULL, `${fullLines.join("\n")}\n`);
  writeFileSync(OUTPUT_MANIFEST, `${JSON.stringify({ pages }, null, 2)}\n`);
}

main();
