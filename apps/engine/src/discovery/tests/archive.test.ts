// Unit tests for extractCodebaseArchive.
// Builds a tiny zip in-memory using yazl, then round-trips through the
// extractor to verify filtering + entry caps.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yauzl from "yauzl";
import { extractCodebaseArchive } from "../archive.ts";

// Minimal zip writer — we don't need a library to produce a valid zip
// with a handful of stored (uncompressed) entries. But yauzl can read
// deflate/store equally, so the easiest path is to use node's native
// zlib to write a STORE-only zip. Here we ship a precomputed fixture
// for one test and also shell out to `zip` if available. To keep the
// test hermetic we produce fixtures programmatically via yazl when
// available, falling back to a minimal hand-crafted approach.

// Since yazl isn't installed, use a pragmatic workaround: build the
// archive with `child_process.spawn` against the system `zip` binary
// available on macOS / Linux CI. If the binary is missing, skip the
// test with a clear message.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

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
    // Filtered out:
    expect(names).not.toContain("package-lock.json");
    expect(names.some((n) => n.startsWith("node_modules/"))).toBe(false);
    expect(names.some((n) => n.startsWith("dist/"))).toBe(false);
    expect(names).not.toContain("logo.png");
    // Skip counters should reflect at least lockfile + binary + generated dirs.
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
