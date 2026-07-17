// Unit tests for the knowledge-bundle parser — the tolerance matrix is the
// contract: nothing is ever rejected (OKF v0.1 "never reject"), reserved
// files are skipped, and the canonical serialization is deterministic
// regardless of input order.

import { describe, expect, test } from "bun:test";
import {
  canonicalBundleSerialization,
  extractFrontmatter,
  normalizeBundlePath,
  parseBundle,
} from "../bundle.ts";

describe("extractFrontmatter — tolerance", () => {
  test("no frontmatter → fm null, body is the raw text", () => {
    const { fm, body } = extractFrontmatter("# Just markdown\n\nBody.");
    expect(fm).toBeNull();
    expect(body).toBe("# Just markdown\n\nBody.");
  });

  test("well-formed frontmatter parses scalars, arrays, and strips the block from body", () => {
    const raw = `---\ntype: Runbook\ntitle: "Deploy"\ntags: [ops, deploy]\ncount: 3\nflag: true\n---\n# Body\n`;
    const { fm, body } = extractFrontmatter(raw);
    expect(fm).toEqual({
      type: "Runbook",
      title: "Deploy",
      tags: ["ops", "deploy"],
      count: 3,
      flag: true,
    });
    expect(body).toBe("# Body");
  });

  test("malformed lines are skipped, never thrown", () => {
    const raw = `---\ntype: Note\nthis line has no colon\n: no key\n---\nbody`;
    const { fm } = extractFrontmatter(raw);
    expect(fm).toEqual({ type: "Note" });
  });

  test("BOM-prefixed frontmatter still parses (Windows editors)", () => {
    const raw = `﻿---\ntype: Note\n---\nbody`;
    const { fm, body } = extractFrontmatter(raw);
    expect(fm).toEqual({ type: "Note" });
    expect(body).toBe("body");
  });

  test("YAML block-sequence tags parse (Obsidian default layout)", () => {
    const raw = `---\ntags:\n  - runbook\n  - deploy\ntype: runbook\n---\nbody`;
    const { fm } = extractFrontmatter(raw);
    expect(fm).toEqual({ tags: ["runbook", "deploy"], type: "runbook" });
  });

  test("zero-indent block-sequence tags parse (Hugo/Jekyll layout)", () => {
    const raw = `---\ntags:\n- runbook\n- deploy\ntype: runbook\n---\nbody`;
    const { fm } = extractFrontmatter(raw);
    expect(fm).toEqual({ tags: ["runbook", "deploy"], type: "runbook" });
  });

  test("flow-list items with quoted commas stay intact (no garbage tags)", () => {
    const raw = `---\ntags: ["ops, sre", db]\n---\nbody`;
    const { fm } = extractFrontmatter(raw);
    expect(fm).toEqual({ tags: ["ops, sre", "db"] });
  });

  test("mid-word apostrophes in unquoted flow-list items are literal (YAML plain scalars)", () => {
    const { fm } = extractFrontmatter(`---\ntags: [don't-panic, runbook]\n---\nbody`);
    expect(fm).toEqual({ tags: ["don't-panic", "runbook"] });
    const { fm: fm2 } = extractFrontmatter(`---\ntags: [team's runbooks, ops]\n---\nbody`);
    expect(fm2).toEqual({ tags: ["team's runbooks", "ops"] });
  });

  test("unterminated frontmatter block → treated as plain content", () => {
    const raw = `---\ntype: Broken\nno closing marker`;
    const { fm, body } = extractFrontmatter(raw);
    expect(fm).toBeNull();
    expect(body).toBe(raw);
  });
});

describe("normalizeBundlePath", () => {
  test("adds leading slash, collapses separators, drops dot segments", () => {
    expect(normalizeBundlePath("concepts/okf.md")).toBe("/concepts/okf.md");
    expect(normalizeBundlePath("./a/../b//c.md")).toBe("/a/b/c.md");
    expect(normalizeBundlePath("\\win\\path.md")).toBe("/win/path.md");
    expect(normalizeBundlePath("/already/rooted.md")).toBe("/already/rooted.md");
  });
});

describe("parseBundle — the tolerance matrix", () => {
  test("one chunk per file; content keeps frontmatter verbatim (unknown keys preserved)", () => {
    const raw = `---\ntype: Concept\ncustom_key: preserved\n---\n# OKF\n`;
    const { chunks } = parseBundle([{ path: "concepts/okf.md", content: raw }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.path).toBe("/concepts/okf.md");
    expect(chunks[0]!.content).toBe(raw);
    expect(chunks[0]!.content).toContain("custom_key: preserved");
  });

  test("title = frontmatter title, else basename without extension", () => {
    const { chunks } = parseBundle([
      { path: "a.md", content: "---\ntitle: Named\ntype: X\n---\nbody" },
      { path: "dir/plain-file.md", content: "no frontmatter" },
    ]);
    expect(chunks.map((c) => c.title)).toEqual(["Named", "plain-file"]);
  });

  test("files without frontmatter or without type are ingested, never rejected", () => {
    const { chunks, skipped } = parseBundle([
      { path: "plain.md", content: "just text" },
      { path: "typed.md", content: "---\ntype: Note\n---\nbody" },
      { path: "untyped.md", content: "---\ntitle: Only Title\n---\nbody" },
    ]);
    expect(chunks).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });

  test("index.md and log.md are skipped at any depth", () => {
    const { chunks, skipped } = parseBundle([
      { path: "index.md", content: "# Nav" },
      { path: "log.md", content: "## 2026-07-01" },
      { path: "sub/Index.MD", content: "# Nested nav" },
      { path: "sub/concept.md", content: "kept" },
    ]);
    expect(chunks.map((c) => c.path)).toEqual(["/sub/concept.md"]);
    expect([...skipped].sort()).toEqual(["/index.md", "/log.md", "/sub/Index.MD"].sort());
  });

  test("duplicate normalized paths: first (sorted) wins, later ones skipped", () => {
    const { chunks, skipped } = parseBundle([
      { path: "./a.md", content: "one" },
      { path: "a.md", content: "two" },
    ]);
    expect(chunks).toHaveLength(1);
    expect(skipped).toEqual(["/a.md"]);
  });

  test("frontmatter type → structural type:<slug> tag; tags list → topical tags", () => {
    const { sourceTags } = parseBundle([
      { path: "t.md", content: "---\ntype: BigQuery Table\ntags: [sales, billing]\n---\nbody" },
    ]);
    expect(sourceTags).toEqual(["type:bigquery-table", "sales", "billing"]);
  });

  test("structural type tags order FIRST across files so the 20-tag cap never drops them", () => {
    const { sourceTags } = parseBundle([
      { path: "a.md", content: "---\ntags: [t1, t2, t3]\n---\na" },
      { path: "z.md", content: "---\ntype: Runbook\n---\nz" },
    ]);
    expect(sourceTags[0]).toBe("type:runbook");
    expect(sourceTags.slice(1)).toEqual(["t1", "t2", "t3"]);
  });

  test("empty/whitespace type mints no tag", () => {
    const { sourceTags } = parseBundle([{ path: "t.md", content: "---\ntype:   \n---\nbody" }]);
    expect(sourceTags).toEqual([]);
  });

  test("structural-shaped frontmatter tags are dropped — untrusted content must not mint routing keys", () => {
    const { sourceTags } = parseBundle([
      {
        path: "evil.md",
        content: "---\ntype: Note\ntags: [domain:payments, harmless]\n---\nbody",
      },
    ]);
    expect(sourceTags).toEqual(["type:note", "harmless"]);
  });

  test("chunks are sorted by path — deterministic ordinals", () => {
    const { chunks } = parseBundle([
      { path: "z.md", content: "z" },
      { path: "a.md", content: "a" },
      { path: "m/n.md", content: "n" },
    ]);
    expect(chunks.map((c) => c.path)).toEqual(["/a.md", "/m/n.md", "/z.md"]);
  });
});

describe("canonicalBundleSerialization — deterministic version input", () => {
  test("input order does not change the serialization", () => {
    const a = canonicalBundleSerialization([
      { path: "b.md", content: "B" },
      { path: "a.md", content: "A" },
    ]);
    const b = canonicalBundleSerialization([
      { path: "a.md", content: "A" },
      { path: "./b.md", content: "B" },
    ]);
    expect(a).toBe(b);
  });

  test("content changes change the serialization", () => {
    const a = canonicalBundleSerialization([{ path: "a.md", content: "one" }]);
    const b = canonicalBundleSerialization([{ path: "a.md", content: "two" }]);
    expect(a).not.toBe(b);
  });

  test("reserved-file churn does NOT rotate the version (agent wikis append to log.md every session)", () => {
    const a = canonicalBundleSerialization([
      { path: "index.md", content: "nav v1" },
      { path: "log.md", content: "## 2026-07-01" },
      { path: "c.md", content: "same" },
    ]);
    const b = canonicalBundleSerialization([
      { path: "index.md", content: "nav v2" },
      { path: "log.md", content: "## 2026-07-16\n\nmore entries" },
      { path: "c.md", content: "same" },
    ]);
    expect(a).toBe(b);
  });

  test("duplicate normalized paths resolve order-INDEPENDENTLY (content tie-break)", () => {
    const forward = canonicalBundleSerialization([
      { path: "a.md", content: "X" },
      { path: "./a.md", content: "Y" },
    ]);
    const reversed = canonicalBundleSerialization([
      { path: "./a.md", content: "Y" },
      { path: "a.md", content: "X" },
    ]);
    expect(forward).toBe(reversed);
  });

  test("duplicate paths: serialization keeps the SAME occurrence the chunks keep (first-wins)", () => {
    const canonical = canonicalBundleSerialization([
      { path: "./a.md", content: "kept" },
      { path: "a.md", content: "shadowed" },
    ]);
    const { chunks } = parseBundle([
      { path: "./a.md", content: "kept" },
      { path: "a.md", content: "shadowed" },
    ]);
    expect(canonical).toContain("kept");
    expect(canonical).not.toContain("shadowed");
    expect(chunks[0]!.content).toBe("kept");
  });
});
