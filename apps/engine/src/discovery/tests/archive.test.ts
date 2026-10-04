import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yauzl from "yauzl";
import { extractCodebaseArchive } from "../archive.ts";

function makeZip(entries: Record<string, string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "archive-test-"));
  try {
    for (const [name, content] of Object.entries(entries)) {
      const full = join(dir, name);
      const parent = full.substring(0, full.lastIndexOf("/"));
      if (parent !== dir) {
        const fs = require("node:fs");
        fs.mkdirSync(parent, { recursive: true });
      }
      writeFileSync(full, content, "utf8");
    }
    const archivePath = join(dir, "out.zip");
    execFileSync("zip", ["-qr", archivePath, "."], { cwd: dir });
    return readFileSync(archivePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("extractCodebaseArchive", () => {
  test("returns source files and skips node_modules / lockfiles / binaries", async () => {
    const zip = makeZip({
      "src/index.ts": "export const x = 1;",
      "src/util.ts": "export const util = () => 42;",
      "README.md": "# project",
      "package.json": JSON.stringify({ name: "demo" }),
      "package-lock.json": "{}",
      "node_modules/dep/index.js": "// noise",
      "dist/bundle.js": "// noise",
      "logo.png": "PNG\r\n",
    });
    const out = await extractCodebaseArchive(zip);
    const names = out.files.map((f) => f.filename).sort();
    expect(names).toContain("src/index.ts");
    expect(names).toContain("src/util.ts");
    expect(names).toContain("README.md");
    expect(names).toContain("package.json");
    expect(names).not.toContain("package-lock.json");
    expect(names.some((n) => n.startsWith("node_modules/"))).toBe(false);
    expect(names.some((n) => n.startsWith("dist/"))).toBe(false);
    expect(names).not.toContain("logo.png");
    expect(out.skipped_count).toBeGreaterThan(0);
  });

  test("extractor round-trip through yauzl validates zip shape", async () => {
    const zip = makeZip({ "a.txt": "hello" });
    await new Promise<void>((resolve, reject) => {
      yauzl.fromBuffer(zip, { lazyEntries: true }, (err, zf) => {
        if (err || !zf) {
          reject(err ?? new Error("no handle"));
          return;
        }
        let sawEntry = false;
        zf.on("entry", () => {
          sawEntry = true;
          zf.readEntry();
        });
        zf.on("end", () => {
          expect(sawEntry).toBe(true);
          resolve();
        });
        zf.on("error", reject);
        zf.readEntry();
      });
    });
  });
});
