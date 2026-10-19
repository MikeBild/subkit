import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetConfigForTests,
  getConfig,
  isConfigLoaded,
  loadConfig,
  setConfigKey,
} from "../config/loader.ts";
import { tenants } from "../db/schema/index.ts";
import { createTestDb } from "../db/tests/setup.ts";
import { _s3OffloadConfigForTests, maybeOffload } from "../execution/offload.ts";
import { STEP_RESULT_DB_BYTES } from "../execution/timeouts.ts";
import { getObjectStore } from "../storage/object-store.ts";
import { OFFLOAD_TEST_BUCKET, useMemoryOffloadStorage } from "./offload-storage.ts";

const configDirs: string[] = [];

async function loadThrowawayConfig(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sk-offload-storage-"));
  configDirs.push(dir);
  _resetConfigForTests();
  await loadConfig({
    env: { NODE_ENV: "test", DATABASE_URL: "postgres://x" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

afterEach(() => {
  _resetConfigForTests();
  for (const dir of configDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("useMemoryOffloadStorage", () => {
  test("without a loaded config it installs a memory store and never loads one", async () => {
    _resetConfigForTests();
    const storage = await useMemoryOffloadStorage();
    expect(getObjectStore()).toBe(storage.store);
    expect(isConfigLoaded()).toBe(false);
    expect(_s3OffloadConfigForTests()).toEqual({
      bucket: OFFLOAD_TEST_BUCKET,
      keyPrefix: "offload",
    });
    await storage.restore();
    expect(getObjectStore()).not.toBe(storage.store);
    expect(isConfigLoaded()).toBe(false);
  });

  test("with a loaded config and an empty bucket it points offload at the test bucket", async () => {
    await loadThrowawayConfig();
    expect(_s3OffloadConfigForTests()).toBeNull();
    const storage = await useMemoryOffloadStorage();
    expect(getConfig().storage.object_store.bucket).toBe(OFFLOAD_TEST_BUCKET);
    expect(_s3OffloadConfigForTests()).toEqual({
      bucket: OFFLOAD_TEST_BUCKET,
      keyPrefix: "offload",
    });
    await storage.restore();
    expect(getConfig().storage.object_store.bucket).toBe("");
    expect(_s3OffloadConfigForTests()).toBeNull();
  });

  test("restore puts a previously configured bucket back", async () => {
    await loadThrowawayConfig();
    await setConfigKey("storage.object_store.bucket", "operator-bucket", { force: true });
    const storage = await useMemoryOffloadStorage();
    expect(getConfig().storage.object_store.bucket).toBe(OFFLOAD_TEST_BUCKET);
    await storage.restore();
    expect(getConfig().storage.object_store.bucket).toBe("operator-bucket");
  });

  test("restore tolerates a config that was unloaded in between", async () => {
    await loadThrowawayConfig();
    const storage = await useMemoryOffloadStorage();
    _resetConfigForTests();
    await storage.restore();
    expect(isConfigLoaded()).toBe(false);
    expect(getObjectStore()).not.toBe(storage.store);
  });

  test("maybeOffload writes a large payload into the memory store while a bucket-less config is loaded", async () => {
    await loadThrowawayConfig();
    const storage = await useMemoryOffloadStorage();
    const database = await createTestDb("memory-offload");
    try {
      const [tenant] = await database.db
        .insert(tenants)
        .values({ slug: "memory-offload", display_name: "Memory offload" })
        .returning();
      const result = await maybeOffload(database.db, {
        tenant_id: tenant!.id,
        execution_id: "exec-1",
        result: { blob: "x".repeat(STEP_RESULT_DB_BYTES + 1) },
      });
      expect(
        result.storage_uri?.startsWith(`s3://${OFFLOAD_TEST_BUCKET}/offload/${tenant!.id}/exec-1/`),
      ).toBe(true);
      expect(await storage.store.list(`offload/${tenant!.id}/exec-1/`)).toHaveLength(1);
    } finally {
      await database.cleanup();
      await storage.restore();
    }
  });
});
