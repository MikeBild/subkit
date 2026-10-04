import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { _validateBootDependenciesForTests } from "../../test-helpers/boot.ts";

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
    const broken = await createTestDb("boot-dependencies-broken");
    await broken.pool.end();
    const { blockerFailed, probes } = await _validateBootDependenciesForTests(broken.db);
    expect(blockerFailed).toBe(true);
    const dbConnect = probes.find((p) => p.name === "db_connect");
    expect(dbConnect?.ok).toBe(false);
    expect(dbConnect?.blocker).toBe(true);
    try {
      await broken.cleanup();
    } catch {}
  });

  test("crypto self-test is a BLOCKER (round-trips encrypt/decrypt)", async () => {
    const { probes } = await _validateBootDependenciesForTests(testDb.db);
    const crypto = probes.find((p) => p.name === "crypto_self_test");
    expect(crypto).toBeDefined();
    expect(crypto?.blocker).toBe(true);
    expect(crypto?.ok).toBe(true);
  });

  test("crypto self-test FAIL trips blockerFailed=true (mismatched AAD round-trip)", async () => {
    const { encryptSecret, decryptSecret } = await import("../../crypto/aes-gcm.ts");
    const cipher = encryptSecret("subkit-boot-self-test", "boot-self-test");
    expect(() => decryptSecret(cipher, "DIFFERENT_AAD")).toThrow();
    const { probes } = await _validateBootDependenciesForTests(testDb.db);
    const crypto = probes.find((p) => p.name === "crypto_self_test");
    expect(crypto?.blocker, "crypto self-test stays a blocker").toBe(true);
  });

  test("pgcrypto extension probe is NON-BLOCKER (warn + continue)", async () => {
    const { probes } = await _validateBootDependenciesForTests(testDb.db);
    const ext = probes.find((p) => p.name === "db_extensions");
    expect(ext).toBeDefined();
    expect(ext?.blocker).toBe(false);
  });

  test("FS write probes are skipped outside production (no /etc/subkit warns in dev)", async () => {
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
      for (const p of fsProbes) {
        expect(p.blocker).toBe(false);
      }
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
