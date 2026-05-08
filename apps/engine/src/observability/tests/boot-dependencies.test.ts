// Boot-time dependency probe — coverage for the blocker classification.
//
// The probe set is the operator's first signal that "something is
// missing" on a fresh host. A future refactor that flips a probe's
// `blocker` flag would silently change the boot-failure surface —
// this test pins the contract.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { _validateBootDependenciesForTests } from "../boot-dependencies.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb("boot-dependencies");
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("_validateBootDependenciesForTests", () => {
  test("clean DB + valid MASTER_KEY → all probes pass, blockerFailed=false", async () => {
    const { blockerFailed, probes } = await _validateBootDependenciesForTests(testDb.db);
    expect(blockerFailed).toBe(false);

    const byName = new Map(probes.map((p) => [p.name, p]));
    expect(byName.get("runtime")?.ok).toBe(true);
    expect(byName.get("crypto_self_test")?.ok).toBe(true);
    expect(byName.get("db_connect")?.ok).toBe(true);
    expect(byName.get("db_extensions")?.ok).toBe(true);
  });

  test("DB connect probe is a BLOCKER (sets blockerFailed=true on failure)", async () => {
    // Drive the failure deterministically: end the pool so SELECT 1 throws.
    // Recreate after the test so other suites don't observe a closed pool.
    const broken = await createTestDb("boot-dependencies-broken");
    await broken.pool.end();
    const { blockerFailed, probes } = await _validateBootDependenciesForTests(broken.db);
    expect(blockerFailed).toBe(true);
    const dbConnect = probes.find((p) => p.name === "db_connect");
    expect(dbConnect?.ok).toBe(false);
    expect(dbConnect?.blocker).toBe(true);
    // Cleanup is a no-op (pool already ended) — call for symmetry but
    // tolerate the throw.
    try {
      await broken.cleanup();
    } catch {
      /* pool already closed */
    }
  });

  test("crypto self-test is a BLOCKER (round-trips encrypt/decrypt)", async () => {
    const { probes } = await _validateBootDependenciesForTests(testDb.db);
    const crypto = probes.find((p) => p.name === "crypto_self_test");
    expect(crypto).toBeDefined();
    expect(crypto?.blocker).toBe(true);
    expect(crypto?.ok).toBe(true);
  });

  test("pgcrypto extension probe is NON-BLOCKER (warn + continue)", async () => {
    // Production runs the migrate path which CREATE EXTENSION's pgcrypto;
    // a pre-installed test DB already has it. Either way the probe must
    // be classified as non-blocker so a stale role privilege gap doesn't
    // exit-1 the engine.
    const { probes } = await _validateBootDependenciesForTests(testDb.db);
    const ext = probes.find((p) => p.name === "db_extensions");
    expect(ext).toBeDefined();
    expect(ext?.blocker).toBe(false);
  });

  test("FS write probes are skipped outside production (no /etc/subkit warns in dev)", async () => {
    // This suite runs with NODE_ENV !== "production" by default, so the
    // probe set must NOT include any fs_write:* entry. Probing /etc/subkit
    // and /var/lib/subkit on a dev laptop emits noise warns and pollutes
    // test stdout.
    const { probes } = await _validateBootDependenciesForTests(testDb.db);
    const fsProbes = probes.filter((p) => p.name.startsWith("fs_write:"));
    expect(fsProbes.length).toBe(0);
  });

  test("FS write probes ARE included when NODE_ENV=production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { probes } = await _validateBootDependenciesForTests(testDb.db);
      const fsProbes = probes.filter((p) => p.name.startsWith("fs_write:"));
      expect(fsProbes.length).toBeGreaterThan(0);
      // Even when the dirs aren't writable on the runner, blocker=false
      // means a fail logs warn but does not exit-1 the engine.
      for (const p of fsProbes) {
        expect(p.blocker).toBe(false);
      }
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
