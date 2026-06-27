// Generate docs/llms.txt — a robots.txt-style index for LLMs.
//
// Walks docs/**/*.md (excluding docs/internal/ and docs/_tapes/) and emits a
// flat, machine-readable index: a title line, a one-line description of the
// docs set, then a Markdown list grouped by audience. Each entry is
//   - [Title](docs/relative/path.md): one-line summary
// where Title is the page's first H1 and the summary is its first non-heading
// sentence, trimmed aggressively. Paths use the raw GitHub-relative form
// (repo-root-relative, e.g. `docs/concepts/connectors.md`).
//
// Output is byte-stable: audiences in AUDIENCE_ORDER, entries sorted by path
// within each audience. No timestamps, no absolute paths.
//
// Wired into `bun run verify` as a docs drift gate (see package.json:
// gen:llms-txt / check:llms-txt-drift), mirroring the settings-doc gate.
//
// Usage:
//   bun run scripts/gen-llms-txt.ts   (writes docs/llms.txt in place)

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const DOCS_DIR = "docs";
const OUTPUT = join(DOCS_DIR, "llms.txt");
const EXCLUDE_DIRS = new Set(["internal", "_tapes"]);

// Audience folder -> section heading, in emission order.
const AUDIENCE_ORDER: ReadonlyArray<{ dir: string; label: string }> = [
  { dir: "concepts", label: "Concepts" },
  { dir: "operators", label: "Operators" },
  { dir: "authors", label: "Authors" },
  { dir: "developers", label: "Developers" },
  { dir: "admins", label: "Admins" },
];

interface Entry {
  audience: string;
  path: string; // repo-root-relative, e.g. docs/concepts/connectors.md
  title: string;
  summary: string;
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
    });
  }

  const lines: string[] = [
    "# sk Documentation",
    "",
    "A robots.txt-style index of the sk documentation set for LLMs: every public page grouped by audience, each with its title, path, and one-line summary.",
  ];

  for (const { dir, label } of AUDIENCE_ORDER) {
    const group = entries
      .filter((e) => e.audience === dir)
      .sort((a, b) => {
        const ar = a.path.endsWith("/README.md");
        const br = b.path.endsWith("/README.md");
        if (ar !== br) return ar ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
    if (group.length === 0) continue;
    lines.push("", `## ${label}`, "");
    for (const e of group) {
      const summary = e.summary ? `: ${e.summary}` : "";
      lines.push(`- [${e.title}](${e.path})${summary}`);
    }
  }

  writeFileSync(OUTPUT, `${lines.join("\n")}\n`);
}

main();
