#!/usr/bin/env bun
//
// check:docs-refs — gate that documentation references resolve.
//
// Detects two true/false classes of broken reference (no heuristics, safe to
// gate in CI):
//   1. Markdown links to a relative path that does not exist, or to a
//      `#anchor` (same-file or cross-file) whose heading is missing.
//   2. Code comments that cite a concept doc (`docs/<name>.md`) which does
//      not exist.
//   3. Code comments that cite a TEST file (`X.test.ts`) that exists nowhere
//      in the repo. A comment saying "pinned by X.test.ts" is the one comment
//      shape allowed to assert behaviour elsewhere — it names its evidence.
//      This class catches the evidence being RENAMED OR DELETED out from under
//      the citation. It deliberately does NOT (and cannot) catch a citation
//      that points at a real test which does not actually check the claim —
//      that stays a review concern. Matching is by basename because the
//      codebase cites tests by filename, not by path.
//
// Wired into `package.json` (`bun run check:docs-refs`), the `verify` gate, and
// `.github/workflows/ci.yml`. Output is line-oriented and deterministic:
//   WARN  <file> -> <target>  (<reason>)
// Exits non-zero on any broken reference. New classes: add below; do not
// silence — if a reference is intentionally dangling, fix the reference.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// GitHub-style heading → anchor slug: lowercase, drop inline markdown and
// punctuation, then map EACH remaining whitespace char to a hyphen (GitHub does
// not collapse runs, so "A & B" → "a--b").
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*~]/g, "") // strip inline emphasis markers (underscores are kept — GitHub keeps them)
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s/g, "-");
}

export function extractAnchors(markdown: string): Set<string> {
  const set = new Set<string>();
  for (const line of markdown.split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) set.add(slugify(m[1]));
  }
  return set;
}

// Markdown link: [text](target) — target may carry a "title" we strip.
const LINK = /\[(?:[^\]]*)\]\(([^)]+)\)/g;
// Code-comment refs to concept docs: docs/<kebab-name>.md (and nested,
// e.g. docs/admins/settings-reference.md). Unnumbered — the docs/ set
// dropped its NN- prefixes, so this matches the stable kebab-case names.
// Kebab-only segments + a leading word/slash boundary deliberately exclude
// example/external paths like `/docs/index.md` (ingestion sample) and
// `nodejs/undici docs/api/Errors.md` (external citation), which are not
// subkit concept docs.
const DOC_REF = /(?<![\w/])docs\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*\.md/g;

// Code-comment refs to a test file: any path or bare filename ending in
// `.test.ts` / `.int.test.ts` / `.component.test.tsx`. The codebase cites
// evidence both ways — "pinned by `mcp/tests/confirm-gate-invariant.test.ts`"
// and a bare `dispatcher.test.ts` — so only the basename is resolved.
// The lookbehind also excludes a leading `.` so a SUFFIX mention — prose like
// "a plain unit test (`.test.ts`, not `.int.test.ts`)" — is not read as a
// citation of a file called `int.test.ts`.
const TEST_REF = /(?<![\w/.])[a-z0-9][\w./-]*\.(?:int\.|component\.)?test\.tsx?(?![\w])/g;

export type Broken = { file: string; target: string; reason: string };

function tracked(...globs: string[]): string[] {
  const out = execFileSync("git", ["ls-files", ...globs], { cwd: REPO, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function findBroken(): Broken[] {
  const broken: Broken[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = (absPath: string): Set<string> => {
    let set = anchorCache.get(absPath);
    if (!set) {
      set = extractAnchors(readFileSync(absPath, "utf8"));
      anchorCache.set(absPath, set);
    }
    return set;
  };

  for (const rel of tracked("*.md")) {
    const abs = join(REPO, rel);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const dir = dirname(abs);
    for (const m of text.matchAll(LINK)) {
      const target = m[1].trim().replace(/\s+["'][^"']*["']$/, ""); // strip optional title
      if (!target) continue;
      if (/^(?:https?:|mailto:|tel:|data:)/.test(target)) continue;
      if (target.startsWith("#")) {
        const anchor = target.slice(1).toLowerCase();
        if (anchor && !anchorsOf(abs).has(anchor)) {
          broken.push({ file: rel, target, reason: "missing anchor (same file)" });
        }
        continue;
      }
      const [pathPart, anchor] = target.split("#");
      const cleanPath = pathPart.split("?")[0];
      if (!cleanPath) continue;
      const tgtAbs = resolve(dir, cleanPath);
      if (!existsSync(tgtAbs)) {
        broken.push({ file: rel, target, reason: "target not found" });
        continue;
      }
      if (anchor && tgtAbs.endsWith(".md") && !anchorsOf(tgtAbs).has(anchor.toLowerCase())) {
        broken.push({ file: rel, target, reason: "missing anchor" });
      }
    }
  }

  // Every test file in the repo, by basename — the resolution target for
  // class 3 above.
  const testBasenames = new Set(
    tracked("**/*.test.ts", "**/*.test.tsx").map((p) => p.split("/").pop() as string),
  );

  const seenCodeRef = new Set<string>();
  for (const rel of tracked(
    "apps/**/*.ts",
    "apps/**/*.tsx",
    "packages/**/*.ts",
    "scripts/**/*.ts",
  )) {
    if (rel.endsWith(".d.ts")) continue;
    let text: string;
    try {
      text = readFileSync(join(REPO, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(DOC_REF)) {
      const docRel = m[0];
      const key = `${rel}::${docRel}`;
      if (seenCodeRef.has(key)) continue;
      seenCodeRef.add(key);
      if (!existsSync(join(REPO, docRel))) {
        broken.push({ file: rel, target: docRel, reason: "code references missing doc" });
      }
    }
    for (const m of text.matchAll(TEST_REF)) {
      const testRef = m[0];
      const base = testRef.split("/").pop() as string;
      // A file citing itself is not a reference.
      if (rel.endsWith(base)) continue;
      const key = `${rel}::${base}`;
      if (seenCodeRef.has(key)) continue;
      seenCodeRef.add(key);
      if (!testBasenames.has(base)) {
        broken.push({ file: rel, target: testRef, reason: "code references missing test" });
      }
    }
  }

  broken.sort((a, b) => `${a.file} ${a.target}`.localeCompare(`${b.file} ${b.target}`));
  return broken;
}

if (import.meta.main) {
  const broken = findBroken();
  for (const b of broken) console.log(`WARN  ${b.file} -> ${b.target}  (${b.reason})`);
  console.log(
    broken.length === 0
      ? "check:docs-refs OK — all markdown links, anchors, and code doc-refs resolve"
      : `check:docs-refs FAIL — ${broken.length} broken reference(s)`,
  );
  process.exit(broken.length === 0 ? 0 : 1);
}
