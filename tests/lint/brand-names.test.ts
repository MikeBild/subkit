// Brand-hygiene gate.
//
// External product/brand names are never introduced into the subkit
// codebase, tests, docs, fixtures, or commit messages. The one sanctioned
// exception is the skill-content denylist — that test *is* the enforcement
// for skill docs themselves and must retain the forbidden strings literally.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// Strings that must not appear anywhere in-repo except in the denylist
// file below. Matched case-insensitive. Keep this list tight — entries
// here are active denials, not a general linguistic filter.
const FORBIDDEN = ["superglue", "super-glue", "super_glue"] as const;

// Paths where the forbidden strings may legitimately appear because that
// file *is* the denylist. Relative to the repo root.
const ALLOWED_FILES = new Set<string>([
  "apps/engine/src/skills/tests/skill-content.test.ts",
  // This test's own source.
  "tests/lint/brand-names.test.ts",
]);

// Directories skipped entirely.
const SKIPPED_DIRS = new Set<string>([
  "node_modules",
  "dist",
  ".git",
  ".bun",
  ".turbo",
  "coverage",
  "build",
  ".output",
  ".next",
  ".cache",
  ".vercel",
  ".DS_Store",
]);

// Extensions we lint — source + docs + test fixtures.
const LINTED_EXT = new Set<string>([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".md",
  ".mdx",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".txt",
  ".sh",
  ".sql",
]);

function* walk(dir: string): Generator<string> {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIPPED_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile()) {
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot) : "";
      if (LINTED_EXT.has(ext)) yield full;
    }
  }
}

describe("brand-name hygiene gate", () => {
  test("external product names are absent outside the sanctioned denylist", () => {
    const hits: Array<{ file: string; term: string; line: number; snippet: string }> = [];
    const pattern = new RegExp(FORBIDDEN.join("|"), "gi");
    for (const file of walk(REPO_ROOT)) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWED_FILES.has(rel)) continue;
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      pattern.lastIndex = 0;
      if (!pattern.test(content)) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const term of FORBIDDEN) {
          const lc = line.toLowerCase();
          if (lc.includes(term.toLowerCase())) {
            hits.push({ file: rel, term, line: i + 1, snippet: line.trim().slice(0, 120) });
          }
        }
      }
    }
    if (hits.length > 0) {
      const detail = hits.map((h) => `  ${h.file}:${h.line} — ${h.term}: ${h.snippet}`).join("\n");
      throw new Error(
        `Forbidden external product name(s) found outside the sanctioned denylist:\n${detail}`,
      );
    }
    expect(hits).toHaveLength(0);
  });
});
