import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { _resetConfigForTests, getConfig, loadConfig } from "../config/loader.ts";
import { runtimeConfigReplicas } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { type EnvHandle, withTestEnv } from "../test-helpers/determinism/env.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { RuntimeConfigCoordinator } from "./coordinator.ts";
import { initializeRuntimeConfig } from "./service.ts";
import { pinVaultMasterKey } from "./vault-participation.ts";

let fixture: TestDb;
let configDir: string;
let environment: EnvHandle;

beforeAll(async () => {
  environment = withTestEnv({ MASTER_KEY: "65".repeat(32) });
  fixture = await createTestDb("coordinator-lifecycle");
  configDir = mkdtempSync(join(tmpdir(), "subkit-coordinator-lifecycle-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: fixture.url, NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  await initializeRuntimeConfig(fixture.db, getConfig());
});

afterAll(async () => {
  _resetConfigForTests();
  environment.restore();
  rmSync(configDir, { recursive: true, force: true });
  await fixture.cleanup();
});

async function registration(instanceId: string) {
  return fixture.db
    .select()
    .from(runtimeConfigReplicas)
    .where(eq(runtimeConfigReplicas.instance_id, instanceId));
}

test("pause retains registration and prevents late heartbeat until explicitly restarted", async () => {
  const coordinator = new RuntimeConfigCoordinator(fixture.db, "test", "paused-fixture");
  await coordinator.start();
  try {
    await coordinator.pause();
    const before = await registration(coordinator.instanceId);
    expect(before).toHaveLength(1);
    await (coordinator as unknown as { tick(): Promise<void> }).tick();
    expect((await registration(coordinator.instanceId))[0]?.last_seen_at).toEqual(
      before[0]?.last_seen_at,
    );
    await coordinator.start();
    expect(await registration(coordinator.instanceId)).toHaveLength(1);
  } finally {
    await coordinator.stop();
  }
  expect(await registration(coordinator.instanceId)).toHaveLength(0);
  await expect(coordinator.start()).rejects.toThrow("runtime_config_coordinator_stopped");
});

test("stop keeps registration until an actual blocked tick settles beyond the old timeout", async () => {
  const coordinator = new RuntimeConfigCoordinator(fixture.db, "test", "blocked-fixture");
  await coordinator.start();
  const blocker = await fixture.pool.connect();
  let tick: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let stopped = false;
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE subkit.runtime_config_state IN ACCESS EXCLUSIVE MODE");
    const backend = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const pid = backend.rows[0]?.pid;
    if (!pid) throw new Error("missing blocker backend");
    const internals = coordinator as unknown as {
      lastHeartbeatAt: number;
      tick(): Promise<void>;
    };
    internals.lastHeartbeatAt = getTestNow();
    tick = internals.tick();
    await waitFor(
      async () => {
        const blocked = await fixture.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
          [pid],
        );
        return blocked.rows.length > 0;
      },
      { tries: 200, sleepMs: 10, label: "coordinator tick reaches database barrier" },
    );
    stopping = coordinator.stop().then(() => {
      stopped = true;
    });
    await expect(
      waitFor(() => stopped, { tries: 220, sleepMs: 25, label: "stop remains pending" }),
    ).rejects.toThrow("stop remains pending timed out");
    expect(stopped).toBe(false);
    expect(await registration(coordinator.instanceId)).toHaveLength(1);
    await blocker.query("COMMIT");
    await tick;
    await stopping;
    expect(stopped).toBe(true);
    expect(await registration(coordinator.instanceId)).toHaveLength(0);
    await internals.tick();
    expect(await registration(coordinator.instanceId)).toHaveLength(0);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await tick;
    await stopping;
    await coordinator.stop();
  }
});

test("stop waits for the startup registration transaction to commit before removing its row", async () => {
  await fixture.db.execute(sql`
    CREATE FUNCTION subkit.coordinator_commit_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.instance_id='commit-fixture' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('coordinator-commit-fixture',0));
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER coordinator_commit_barrier AFTER INSERT OR UPDATE ON subkit.runtime_config_replicas
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION subkit.coordinator_commit_barrier();
  `);
  const coordinator = new RuntimeConfigCoordinator(fixture.db, "test", "commit-fixture");
  const blocker = await fixture.pool.connect();
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let stopped = false;
  try {
    await blocker.query(
      "SELECT pg_advisory_lock(hashtextextended('coordinator-commit-fixture',0))",
    );
    const backend = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const pid = backend.rows[0]?.pid;
    if (!pid) throw new Error("missing commit barrier backend");
    starting = coordinator.registerStartup((tx) => pinVaultMasterKey(tx));
    await waitFor(
      async () => {
        const blocked = await fixture.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
          [pid],
        );
        return blocked.rows.length > 0;
      },
      { tries: 200, sleepMs: 10, label: "registration reaches commit barrier" },
    );
    stopping = coordinator.stop().then(() => {
      stopped = true;
    });
    await expect(
      waitFor(() => stopped, { tries: 10, sleepMs: 10, label: "stop waits for startup commit" }),
    ).rejects.toThrow("stop waits for startup commit timed out");
    await blocker.query(
      "SELECT pg_advisory_unlock(hashtextextended('coordinator-commit-fixture',0))",
    );
    await starting;
    await stopping;
    expect(stopped).toBe(true);
    expect(await registration(coordinator.instanceId)).toHaveLength(0);
  } finally {
    await blocker.query(
      "SELECT pg_advisory_unlock(hashtextextended('coordinator-commit-fixture',0))",
    );
    blocker.release();
    await starting;
    await stopping;
    await coordinator.stop();
    await fixture.db.execute(sql`
      DROP TRIGGER coordinator_commit_barrier ON subkit.runtime_config_replicas;
      DROP FUNCTION subkit.coordinator_commit_barrier();
    `);
  }
});
