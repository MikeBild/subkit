import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

interface CollectedBundle {
  files: { path: string; content: string }[];
  skipped_non_markdown: number;
}

const BUNDLE_MAX_FILES = 500;

const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

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

export function defaultBundleName(dir: string, files: CollectedBundle["files"]): string {
  const index = files.find((f) => f.path === "/index.md");
  if (index) {
    const body = index.content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
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
