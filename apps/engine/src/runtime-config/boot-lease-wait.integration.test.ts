import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { _resetConfigForTests, getConfig, loadConfig } from "../config/loader.ts";
import { runtimeConfigReplicas, runtimeConfigState } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import {
  activateRuntimeRevision,
  getRuntimeConfigState,
  initializeRuntimeConfig,
  RuntimeConfigConflictError,
  saveRuntimeConfigPatch,
} from "./service.ts";

let tdb: TestDb;
let configDir: string;

beforeAll(async () => {
  process.env.MASTER_KEY = "44".repeat(32);
  tdb = await createTestDb("runtime-config-lease-wait");
  configDir = mkdtempSync(join(tmpdir(), "sk-lease-wait-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  await initializeRuntimeConfig(tdb.db, getConfig());
});

afterAll(async () => {
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  await tdb.cleanup();
});

async function waitForRestart(port: number): Promise<void> {
  const [state] = await tdb.db.select().from(runtimeConfigState);
  const saved = await saveRuntimeConfigPatch(tdb.db, {
    expected_revision: Number(state?.desired_revision),
    changes: { "server.port": port },
    scope: "global",
    created_by: null,
  });
  const activation = await activateRuntimeRevision(tdb.db, saved.saved_revision);
  expect(activation.activation_status).toBe("restart_required");
}

async function holdLease(instanceId: string): Promise<void> {
  await tdb.db
    .insert(runtimeConfigReplicas)
    .values({ instance_id: instanceId, product_version: "test", last_seen_at: sql`now()` })
    .onConflictDoUpdate({
      target: runtimeConfigReplicas.instance_id,
      set: { last_seen_at: sql`now()` },
    });
}

async function dropLease(instanceId: string): Promise<void> {
  await tdb.db
    .delete(runtimeConfigReplicas)
    .where(eq(runtimeConfigReplicas.instance_id, instanceId));
}

describe("boot with a restart-required revision and a fresh foreign lease", () => {
  test("waits until the previous process's lease runs out, then promotes", async () => {
    await waitForRestart(3201);
    await holdLease("previous-process");
    const sleeps: number[] = [];
    const state = await initializeRuntimeConfig(tdb.db, getConfig(), {
      instanceId: "next-process",
      maxWaitMs: 10_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) await dropLease("previous-process");
      },
    });
    expect(sleeps.length).toBe(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0);
    expect(state.active_revision).toBe(state.saved_revision);
    expect(getConfig().server.port).toBe(3201);
    const after = await getRuntimeConfigState(tdb.db);
    expect(after.active_revision).toBe(after.saved_revision);
    expect(after.pending_restart_fields).toEqual([]);
  });

  test("a lease that stays fresh is a live replica: boot still refuses after the wait", async () => {
    await waitForRestart(3202);
    await holdLease("live-replica");
    let sleeps = 0;
    try {
      await expect(
        initializeRuntimeConfig(tdb.db, getConfig(), {
          instanceId: "next-process",
          maxWaitMs: 150,
          sleep: async (ms) => {
            sleeps += 1;
            await holdLease("live-replica");
            await Bun.sleep(Math.min(ms, 40));
          },
        }),
      ).rejects.toBeInstanceOf(RuntimeConfigConflictError);
      expect(sleeps).toBeGreaterThan(0);
      expect(getConfig().server.port).toBe(3201);
    } finally {
      await dropLease("live-replica");
    }
  });

  test("its own replica id is no foreign lease: a restarted container promotes at once", async () => {
    await holdLease("container-pid-1");
    let slept = false;
    const state = await initializeRuntimeConfig(tdb.db, getConfig(), {
      instanceId: "container-pid-1",
      sleep: async () => {
        slept = true;
      },
    });
    expect(slept).toBe(false);
    expect(state.active_revision).toBe(state.saved_revision);
    expect(getConfig().server.port).toBe(3202);
    await dropLease("container-pid-1");
  });
});
