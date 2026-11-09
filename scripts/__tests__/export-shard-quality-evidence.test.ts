import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBundleFile } from "../export-shard-quality-evidence.ts";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "subkit-shard-bundle-"));
  roots.push(root);
  mkdirSync(join(root, "reports"));
  writeFileSync(join(root, "reports", "proof.json"), "proof");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readBundleFile", () => {
  test("reads only canonical regular files below a real repository root", () => {
    const root = fixture();
    expect(new TextDecoder().decode(readBundleFile(root, "reports/proof.json"))).toBe("proof");
    for (const path of ["../proof", "/etc/passwd", "reports/../proof.json", "reports\\proof.json"])
      expect(() => readBundleFile(root, path)).toThrow();
  });

  test("rejects symlink leaves and a symlinked repository root", () => {
    const root = fixture();
    symlinkSync(join(root, "reports", "proof.json"), join(root, "reports", "linked.json"));
    expect(() => readBundleFile(root, "reports/linked.json")).toThrow("symlink");
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    roots.push(alias);
    expect(() => readBundleFile(alias, "reports/proof.json")).toThrow("real directory");
  });
});
