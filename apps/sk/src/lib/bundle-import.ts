// Knowledge-bundle directory walker — shared by the CLI
// (`sk knowledge-sources import`) and the REPL slash (`/knowledge import`).
// Pure local-FS collection; the engine's tolerant bundle parser does the
// rest (frontmatter, reserved-file skipping, tag mapping).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

export interface CollectedBundle {
  files: { path: string; content: string }[];
  /** Non-markdown files encountered and left out of the bundle. */
  skipped_non_markdown: number;
}

/** Matches the engine route's `files` cap (`CreateKnowledgeSourceBundleBody`). */
export const BUNDLE_MAX_FILES = 500;

const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/**
 * Recursively collect Markdown files recursively under `dir` (dot-directories like `.git`
 * and `.obsidian` are skipped). Paths are bundle-relative with a leading
 * `/` and forward slashes — the form the engine stores on each chunk.
 */
export function collectBundleFiles(dir: string): CollectedBundle {
  const root = statSync(dir);
  if (!root.isDirectory()) throw new Error(`not a directory: ${dir}`);

  const files: { path: string; content: string }[] = [];
  let skippedNonMarkdown = 0;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) {
        skippedNonMarkdown++;
        continue;
      }
      const rel = relative(dir, full).split("\\").join("/");
      files.push({ path: `/${rel}`, content: readFileSync(full, "utf8") });
      if (files.length > BUNDLE_MAX_FILES) {
        throw new Error(
          `bundle exceeds ${BUNDLE_MAX_FILES} markdown files — split the directory into multiple sources`,
        );
      }
    }
  };
  walk(dir);

  if (files.length === 0) throw new Error(`no markdown files found under ${dir}`);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped_non_markdown: skippedNonMarkdown };
}

/**
 * Bundle display name: the first REAL H1 of the root `index.md` when
 * present, otherwise the directory basename. Frontmatter (whose `# ...`
 * comment lines are not headings — and whose changing bot comments would
 * otherwise rotate the derived name and thereby the upsert slug on every
 * import) and fenced code blocks are skipped before scanning.
 */
export function defaultBundleName(dir: string, files: CollectedBundle["files"]): string {
  const index = files.find((f) => f.path === "/index.md");
  if (index) {
    const body = index.content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    let inFence = false;
    for (const line of body.split(/\r?\n/)) {
      if (/^(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const h1 = /^#\s+(.+)$/.exec(line);
      if (h1?.[1]) return h1[1].trim();
    }
  }
  return basename(dir) || "knowledge-bundle";
}
