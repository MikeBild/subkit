// Sanity that the build-time macro shipped a journal + SQL set that
// agrees with the on-disk migration files. A regression here means the
// embedded bundle is stale w.r.t. the source tree (e.g. someone added a
// .sql but the macro's hash set still reflects the prior state) — the
// exact class of bug issue #149 was about.
//
// We re-read the source files at test time and compare against the
// macro-inlined data. Bun executes macros at module-load, so the
// embedded bundle reflects whatever the FS looked like when this test
// suite started — which is the same FS the next `bun build --compile`
// would see.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listEmbeddedMigrations } from "../migrate.ts";

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "..", "migrations");

describe("embedded migration bundle", () => {
  test("entry count matches journal entry count on disk", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(listEmbeddedMigrations().length).toBe(journal.entries.length);
  });

  test("every embedded SQL hash equals the SHA-256 of the on-disk file", () => {
    for (const m of listEmbeddedMigrations()) {
      const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, `${m.tag}.sql`), "utf8");
      const onDiskHash = createHash("sha256").update(raw).digest("hex");
      expect(m.hash).toBe(onDiskHash);
    }
  });

  test("every embedded migration carries at least one SQL statement", () => {
    for (const m of listEmbeddedMigrations()) {
      expect(m.statements.length).toBeGreaterThanOrEqual(1);
      expect(m.tag.length).toBeGreaterThan(0);
    }
  });

  test("entries are in monotonic idx order", () => {
    const idxs = listEmbeddedMigrations().map((m) => m.idx);
    for (let i = 1; i < idxs.length; i++) {
      expect(idxs[i]!).toBeGreaterThan(idxs[i - 1]!);
    }
  });
});
