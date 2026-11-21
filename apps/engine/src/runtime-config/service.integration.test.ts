import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_TENANT_ID } from "../audit/types.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../config/loader.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { testEnv } from "../test-helpers/determinism/env.ts";
import { RuntimeConfigCoordinator } from "./coordinator.ts";
import {
  activateRuntimeRevision,
  createSecretVersion,
  DATABASE_URL_BOOTSTRAP_SENTINEL,
  getRuntimeRevision,
  initializeRuntimeConfig,
  RuntimeConfigConflictError,
  RuntimeConfigValidationError,
  RuntimeSecretInUseError,
  revokeSecretVersion,
  saveRuntimeConfigPatch,
} from "./service.ts";

const ACTIVATION_ACTOR = {
  tenant_id: SYSTEM_TENANT_ID,
  actor_type: "system" as const,
  actor_id: null,
  source: "test",
};

let tdb: TestDb;
let configDir: string;

beforeAll(async () => {
  testEnv.MASTER_KEY = "11".repeat(32);
  tdb = await createTestDb("runtime-config");
  configDir = mkdtempSync(join(tmpdir(), "sk-runtime-config-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
});

afterAll(async () => {
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  await tdb.cleanup();
});

describe("runtime configuration revisions", () => {
  test("seeds once, encrypts secrets, ACKs hot activation, and preserves restart separation", async () => {
    const initial = await initializeRuntimeConfig(tdb.db, getConfig());
    expect(initial).toMatchObject({
      saved_revision: 1,
      active_revision: 1,
      activation_status: "active",
    });
    const initialRevision = await getRuntimeRevision(tdb.db, 1);
    expect((initialRevision.document.database as { url: string }).url).toBe(
      DATABASE_URL_BOOTSTRAP_SENTINEL,
    );
    expect(JSON.stringify(initialRevision.document)).not.toContain(tdb.url);

    const secondBoot = await initializeRuntimeConfig(tdb.db, {
      ...getConfig(),
      database: { ...getConfig().database, url: "postgres://rotated-bootstrap/runtime" },
      log: { ...getConfig().log, level: "fatal" },
    });
    expect(secondBoot.saved_revision).toBe(1);
    expect(getConfig().log.level).toBe("info");
    expect(getConfig().database.url).toBe("postgres://rotated-bootstrap/runtime");

    const coordinator = new RuntimeConfigCoordinator(tdb.db, "test", "replica-a");
    await coordinator.start();
    try {
      const savedHot = await saveRuntimeConfigPatch(tdb.db, {
        expected_revision: 1,
        changes: { "log.level": "debug" },
        scope: "global",
        created_by: null,
      });
      expect(savedHot).toMatchObject({
        saved_revision: 2,
        active_revision: 1,
        activation_status: "saved",
        pending_restart_fields: [],
      });

      const activated = await activateRuntimeRevision(tdb.db, 2, ACTIVATION_ACTOR);
      expect(activated.activation_status).toBe("active");
      expect(activated.replicas).toEqual([
        expect.objectContaining({ instance_id: "replica-a", status: "ack" }),
      ]);
      for (let attempt = 0; attempt < 100 && getConfig().log.level !== "debug"; attempt += 1) {
        await Bun.sleep(20);
      }
      expect(getConfig().log.level).toBe("debug");

      await expect(
        saveRuntimeConfigPatch(tdb.db, {
          expected_revision: 1,
          changes: { "log.level": "warn" },
          scope: "global",
          created_by: null,
        }),
      ).rejects.toBeInstanceOf(RuntimeConfigConflictError);

      const secret = await createSecretVersion(tdb.db, {
        name: "mcp.transport-key",
        value: "plaintext-must-never-land-in-settings",
        created_by: null,
      });
      const savedSecret = await saveRuntimeConfigPatch(tdb.db, {
        expected_revision: 2,
        changes: { "mcp.api_key": secret.reference },
        scope: "global",
        created_by: null,
      });
      expect(savedSecret.saved_revision).toBe(3);
      const stored = await getRuntimeRevision(tdb.db, 3);
      expect((stored.document.mcp as { api_key: string }).api_key).toBe(secret.reference);
      expect(JSON.stringify(stored.document)).not.toContain(
        "plaintext-must-never-land-in-settings",
      );
      expect((await activateRuntimeRevision(tdb.db, 3, ACTIVATION_ACTOR)).activation_status).toBe(
        "active",
      );
      await expect(
        revokeSecretVersion(tdb.db, {
          name: secret.name,
          version: secret.version,
        }),
      ).rejects.toBeInstanceOf(RuntimeSecretInUseError);

      const restart = await saveRuntimeConfigPatch(tdb.db, {
        expected_revision: 3,
        changes: { "server.port": 3001 },
        scope: "global",
        created_by: null,
      });
      expect(restart.pending_restart_fields).toEqual(["server.port"]);
      const restartActivation = await activateRuntimeRevision(
        tdb.db,
        restart.saved_revision,
        ACTIVATION_ACTOR,
      );
      expect(restartActivation).toMatchObject({
        active_revision: 3,
        activation_status: "restart_required",
        pending_restart_fields: ["server.port"],
      });
      expect(getConfig().server.port).toBe(3000);
    } finally {
      await coordinator.stop();
    }

    const afterRestart = await initializeRuntimeConfig(tdb.db, getConfig());
    expect(afterRestart).toMatchObject({
      saved_revision: 4,
      active_revision: 4,
      activation_status: "active",
    });
    expect(getConfig().server.port).toBe(3001);

    const tenantDefault = await saveRuntimeConfigPatch(tdb.db, {
      expected_revision: 4,
      changes: { "connectors.mcp.per_server_manifest_byte_cap": 12_300 },
      scope: "global",
      created_by: null,
    });
    expect(tenantDefault.saved_revision).toBe(5);

    await expect(
      saveRuntimeConfigPatch(tdb.db, {
        expected_revision: 5,
        changes: { "log.level": "secret://mcp.transport-key/1" },
        scope: "global",
        created_by: null,
      }),
    ).rejects.toBeInstanceOf(RuntimeConfigValidationError);
    await expect(
      saveRuntimeConfigPatch(tdb.db, {
        expected_revision: 5,
        changes: { "database.url": "secret://mcp.transport-key/1" },
        scope: "global",
        created_by: null,
      }),
    ).rejects.toBeInstanceOf(RuntimeConfigValidationError);
  });
});
