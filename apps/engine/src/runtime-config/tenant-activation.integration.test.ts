import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_TENANT_ID } from "../audit/types.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../config/loader.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { testEnv } from "../test-helpers/determinism/env.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { RuntimeConfigCoordinator } from "./coordinator.ts";
import {
  activateRuntimeRevision,
  assertNoPendingEngineChange,
  createSecretVersion,
  getRuntimeConfigState,
  getRuntimeRevision,
  initializeRuntimeConfig,
  RuntimeConfigPendingError,
  RuntimeConfigValidationError,
  revisionChangesOnlyTenant,
  saveRuntimeConfigPatch,
} from "./service.ts";

const ACTOR = {
  tenant_id: SYSTEM_TENANT_ID,
  actor_type: "system" as const,
  actor_id: null,
  source: "test",
};

const nextId = createDeterministicUuidFactory(2_114);
const tenantA = nextId();
const tenantB = nextId();

let tdb: TestDb;
let configDir: string;
let coordinator: RuntimeConfigCoordinator;

beforeAll(async () => {
  testEnv.MASTER_KEY = "55".repeat(32);
  tdb = await createTestDb("runtime_tenant_activation");
  await seedTenant(tdb.db, { id: tenantA, slug: "activation-a", display_name: "Activation A" });
  await seedTenant(tdb.db, { id: tenantB, slug: "activation-b", display_name: "Activation B" });
  configDir = mkdtempSync(join(tmpdir(), "subkit-runtime-tenant-activation-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  await initializeRuntimeConfig(tdb.db, getConfig());
  coordinator = new RuntimeConfigCoordinator(tdb.db, "test", "tenant-activation-replica");
  await coordinator.start();
});

afterAll(async () => {
  await coordinator.stop();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  await tdb.cleanup();
});

describe("revisionChangesOnlyTenant", () => {
  const active = { log: { level: "info" }, tenants: { [tenantB]: { llm: { model: "b" } } } };

  test("accepts a change confined to the named tenant overlay", () => {
    expect(
      revisionChangesOnlyTenant(
        active,
        { ...active, tenants: { ...active.tenants, [tenantA]: { llm: { model: "a" } } } },
        tenantA,
      ),
    ).toBe(true);
  });

  test("rejects an engine-wide change", () => {
    expect(revisionChangesOnlyTenant(active, { ...active, log: { level: "debug" } }, tenantA)).toBe(
      false,
    );
  });

  test("rejects a change to another tenant's overlay", () => {
    expect(
      revisionChangesOnlyTenant(
        active,
        { ...active, tenants: { [tenantB]: { llm: { model: "x" } } } },
        tenantA,
      ),
    ).toBe(false);
  });
});

describe("tenant-restricted saves and activations", () => {
  test("a tenant overlay saves against the active revision and activates", async () => {
    const state = await getRuntimeConfigState(tdb.db);
    const saved = await saveRuntimeConfigPatch(tdb.db, {
      expected_revision: state.saved_revision,
      changes: { "llm.model": "tenant-a-model" },
      scope: "tenant",
      tenant_id: tenantA,
      created_by: null,
      restrict_to_tenant: tenantA,
    });
    const activated = await activateRuntimeRevision(tdb.db, saved.saved_revision, ACTOR, {
      restrict_to_tenant: tenantA,
    });
    expect(activated.activation_status).toBe("active");
    expect((await getRuntimeConfigState(tdb.db)).active_revision).toBe(saved.saved_revision);
    const revision = await getRuntimeRevision(tdb.db, saved.saved_revision);
    expect(revision.document.tenants).toEqual({ [tenantA]: { llm: { model: "tenant-a-model" } } });
  });

  test("a tenant-restricted save refuses every secret reference it does not own", async () => {
    const foreign = await createSecretVersion(tdb.db, {
      name: `tenants.${tenantB}.settings.llm.api_key`,
      value: "sk-tenant-b",
      created_by: null,
    });
    const engineWide = await createSecretVersion(tdb.db, {
      name: "settings.llm.api_key",
      value: "subkit-engine",
      created_by: null,
    });
    const references = [
      foreign.reference,
      engineWide.reference,
      `secret://tenants.${tenantB}.settings.llm.api_key/99`,
      "secret://settings.llm.missing/1",
    ];
    const before = await getRuntimeConfigState(tdb.db);
    const messages = new Set<string>();
    for (const reference of references) {
      const refused = await saveRuntimeConfigPatch(tdb.db, {
        expected_revision: before.saved_revision,
        changes: { "llm.api_key": reference },
        scope: "tenant",
        tenant_id: tenantA,
        created_by: null,
        restrict_to_tenant: tenantA,
      }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(RuntimeConfigValidationError);
      messages.add((refused as Error).message);
    }
    expect(messages.size).toBe(1);
    expect(await getRuntimeConfigState(tdb.db)).toEqual(before);
  });

  test("a tenant-restricted save accepts the tenant's own secret reference", async () => {
    const own = await createSecretVersion(tdb.db, {
      name: `tenants.${tenantA}.settings.llm.api_key`,
      value: "sk-tenant-a",
      created_by: null,
    });
    const state = await getRuntimeConfigState(tdb.db);
    const saved = await saveRuntimeConfigPatch(tdb.db, {
      expected_revision: state.saved_revision,
      changes: { "llm.api_key": own.reference },
      scope: "tenant",
      tenant_id: tenantA,
      created_by: null,
      restrict_to_tenant: tenantA,
    });
    const activated = await activateRuntimeRevision(tdb.db, saved.saved_revision, ACTOR, {
      restrict_to_tenant: tenantA,
    });
    expect(activated.activation_status).toBe("active");
  });

  test("a tenant-restricted save cannot target another tenant", async () => {
    const state = await getRuntimeConfigState(tdb.db);
    await expect(
      saveRuntimeConfigPatch(tdb.db, {
        expected_revision: state.saved_revision,
        changes: { "llm.model": "elsewhere" },
        scope: "tenant",
        tenant_id: tenantB,
        created_by: null,
        restrict_to_tenant: tenantA,
      }),
    ).rejects.toBeInstanceOf(RuntimeConfigValidationError);
    expect(await getRuntimeConfigState(tdb.db)).toEqual(state);
  });

  test("a restricted activation refuses a revision that changes the engine", async () => {
    const state = await getRuntimeConfigState(tdb.db);
    const saved = await saveRuntimeConfigPatch(tdb.db, {
      expected_revision: state.saved_revision,
      changes: { "log.level": "warn" },
      scope: "global",
      created_by: null,
    });
    await expect(
      activateRuntimeRevision(tdb.db, saved.saved_revision, ACTOR, { restrict_to_tenant: tenantA }),
    ).rejects.toBeInstanceOf(RuntimeConfigPendingError);
    const after = await getRuntimeConfigState(tdb.db);
    expect(after.active_revision).toBe(state.active_revision);
    expect(after.saved_revision).toBe(saved.saved_revision);
  });

  test("a tenant save is refused while an engine revision waits for activation", async () => {
    await expect(assertNoPendingEngineChange(tdb.db)).rejects.toBeInstanceOf(
      RuntimeConfigPendingError,
    );
    const state = await getRuntimeConfigState(tdb.db);
    await expect(
      saveRuntimeConfigPatch(tdb.db, {
        expected_revision: state.saved_revision,
        changes: { "llm.model": "while-pending" },
        scope: "tenant",
        tenant_id: tenantA,
        created_by: null,
        restrict_to_tenant: tenantA,
      }),
    ).rejects.toMatchObject({ code: "operator_change_pending" });
    expect(await getRuntimeConfigState(tdb.db)).toEqual(state);
  });
});
