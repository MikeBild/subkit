import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectBundleFiles, defaultBundleName } from "./bundle-import.ts";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sk-bundle-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("collectBundleFiles", () => {
  test("collects markdown recursively with bundle-relative leading-slash paths, sorted", () => {
    const dir = makeDir();
    mkdirSync(join(dir, "runbooks"));
    writeFileSync(join(dir, "z-note.md"), "z");
    writeFileSync(join(dir, "runbooks", "deploy.md"), "# Deploy");
    const { files } = collectBundleFiles(dir);
    expect(files.map((f) => f.path)).toEqual(["/runbooks/deploy.md", "/z-note.md"]);
    expect(files[0]!.content).toBe("# Deploy");
  });

  test("skips dot-directories, node_modules, non-markdown files, and symlinks", () => {
    const dir = makeDir();
    mkdirSync(join(dir, ".obsidian"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, ".obsidian", "hidden.md"), "hidden");
    writeFileSync(join(dir, "node_modules", "dep.md"), "dep");
    writeFileSync(join(dir, "image.png"), "binary");
    writeFileSync(join(dir, "kept.md"), "kept");
    symlinkSync(join(dir, "kept.md"), join(dir, "link.md"));
    const { files, skipped_non_markdown } = collectBundleFiles(dir);
    expect(files.map((f) => f.path)).toEqual(["/kept.md"]);
    expect(skipped_non_markdown).toBe(1);
  });

  test("empty directory → friendly error", () => {
    const dir = makeDir();
    expect(() => collectBundleFiles(dir)).toThrow(/no markdown files/);
  });

  test("file path instead of directory → friendly error", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "solo.md"), "x");
    expect(() => collectBundleFiles(join(dir, "solo.md"))).toThrow(/not a directory/);
  });
});

describe("defaultBundleName", () => {
  test("prefers the root index.md H1", () => {
    const dir = makeDir();
    const files = [
      { path: "/index.md", content: "# Team Wiki\n\n* [a](a.md)" },
      { path: "/a.md", content: "a" },
    ];
    expect(defaultBundleName(dir, files)).toBe("Team Wiki");
  });

  test("falls back to the directory basename", () => {
    const dir = makeDir();
    expect(defaultBundleName(dir, [{ path: "/a.md", content: "a" }])).toBe(
      dir.split("/").pop() as string,
    );
  });

  test("frontmatter comment lines are not headings (bot comments must not rotate the name/slug)", () => {
    const dir = makeDir();
    const files = [
      {
        path: "/index.md",
        content: "---\n# synced 2026-07-16T02:00\ntitle: X\n---\n# Team Wiki\n\nbody",
      },
    ];
    expect(defaultBundleName(dir, files)).toBe("Team Wiki");
  });

  test("fenced code lines are not headings", () => {
    const dir = makeDir();
    const files = [{ path: "/index.md", content: "```\n# not a heading\n```\n\n# Real Title\n" }];
    expect(defaultBundleName(dir, files)).toBe("Real Title");
  });
});
