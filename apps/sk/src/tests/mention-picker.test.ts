import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMention, extractMention, scanFiles } from "../repl/mention-picker.tsx";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-mp-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("extractMention", () => {
  test("returns null when no mention is in progress", () => {
    expect(extractMention("hello world", 11)).toBeNull();
    expect(extractMention("", 0)).toBeNull();
  });

  test("finds a mention at the end of the buffer", () => {
    expect(extractMention("send @REA", 9)).toEqual({ query: "REA", start: 5 });
  });

  test("returns the mention at the cursor, not the end", () => {
    expect(extractMention("see @foo and @bar", 8)).toEqual({ query: "foo", start: 4 });
  });

  test("ignores a mention broken by whitespace", () => {
    expect(extractMention("see @ foo", 9)).toBeNull();
  });
});

describe("applyMention", () => {
  test("splices the candidate value + space at the token position", () => {
    const { value, cursor } = applyMention("send @RE", 8, 5, {
      value: "README.md",
      label: "README.md",
      kind: "file",
    });
    expect(value).toBe("send @README.md ");
    expect(cursor).toBe(16);
  });

  test("preserves the suffix after the cursor", () => {
    const { value } = applyMention("see @x  later", 6, 4, {
      value: "file.ts",
      label: "file.ts",
      kind: "file",
    });
    expect(value).toBe("see @file.ts   later");
  });
});

describe("scanFiles", () => {
  test("returns matches under a tmpdir filtered by query", () => {
    const root = tmp();
    writeFileSync(join(root, "README.md"), "# hi");
    writeFileSync(join(root, "CHANGELOG.md"), "changes");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "x");
    const results = scanFiles(root, "README");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.value).toBe("README.md");
  });

  test("empty query returns a shallow listing", () => {
    const root = tmp();
    writeFileSync(join(root, "a.md"), "a");
    writeFileSync(join(root, "b.md"), "b");
    const results = scanFiles(root, "");
    const values = results.map((r) => r.value);
    expect(values).toContain("a.md");
    expect(values).toContain("b.md");
  });

  test("skips dotfiles and node_modules", () => {
    const root = tmp();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "hidden.js"), "x");
    writeFileSync(join(root, "visible.ts"), "v");
    const results = scanFiles(root, "");
    const values = results.map((r) => r.value);
    expect(values).toContain("visible.ts");
    expect(values).not.toContain(".git/HEAD");
    expect(values).not.toContain("node_modules/hidden.js");
  });

  test("honors the limit arg", () => {
    const root = tmp();
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}.ts`), "");
    const results = scanFiles(root, "f", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
