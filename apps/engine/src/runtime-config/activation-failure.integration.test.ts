import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { SYSTEM_TENANT_ID } from "../audit/types.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../config/loader.ts";
import { runtimeConfigReplicas } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { failRuntimeActivation } from "./activation-failure.ts";
import {
  activateRuntimeRevision,
  assertNoPendingEngineChange,
  getRuntimeConfigState,
  getRuntimeRevision,
  initializeRuntimeConfig,
  saveRuntimeConfigPatch,
} from "./service.ts";

const nextId = createDeterministicUuidFactory(3191);
const tenantA = nextId();
const tenantB = nextId();
let tdb: TestDb;
let configDir: string;

beforeEach(async () => {
  tdb = await createTestDb("activation-failure");
  configDir = mkdtempSync(join(tmpdir(), "subkit-activation-failure-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  await initializeRuntimeConfig(tdb.db, getConfig());
});

afterEach(async () => {
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  await tdb.cleanup();
});

async function saveTenant() {
  const state = await getRuntimeConfigState(tdb.db);
  return saveRuntimeConfigPatch(tdb.db, {
    expected_revision: state.saved_revision,
    changes: { "llm.model": "tenant-model" },
    scope: "tenant",
    tenant_id: tenantA,
    restrict_to_tenant: tenantA,
    created_by: null,
  });
}

test("failed tenant activation releases other tenants while retaining the reviewed failure", async () => {
  const saved = await saveTenant();
  await expect(
    activateRuntimeRevision(
      tdb.db,
      saved.saved_revision,
      { tenant_id: SYSTEM_TENANT_ID, actor_type: "system", actor_id: null, source: "test" },
      { restrict_to_tenant: tenantA },
    ),
  ).rejects.toThrow("no healthy runtime replicas");
  expect((await getRuntimeRevision(tdb.db, saved.saved_revision)).status).toBe("failed");
  await expect(assertNoPendingEngineChange(tdb.db)).resolves.toBeUndefined();
  const state = await getRuntimeConfigState(tdb.db);
  expect(state.saved_revision).toBe(state.active_revision);
  const other = await saveRuntimeConfigPatch(tdb.db, {
    expected_revision: state.active_revision,
    changes: { "llm.model": "other-tenant-model" },
    scope: "tenant",
    tenant_id: tenantB,
    restrict_to_tenant: tenantB,
    created_by: null,
  });
  const revision = await getRuntimeRevision(tdb.db, other.saved_revision);
  expect(revision.document.tenants).toEqual({
    [tenantB]: { llm: { model: "other-tenant-model" } },
  });
});

test("failure cleanup cannot discard a newer staged revision", async () => {
  const saved = await saveTenant();
  const newer = await saveRuntimeConfigPatch(tdb.db, {
    expected_revision: saved.saved_revision,
    changes: { "log.level": "warn" },
    scope: "global",
    created_by: null,
  });
  await failRuntimeActivation(tdb.db, saved.saved_revision, "prepare rejected", tenantA);
  expect((await getRuntimeConfigState(tdb.db)).saved_revision).toBe(newer.saved_revision);
  expect((await getRuntimeRevision(tdb.db, saved.saved_revision)).status).toBe("failed");
});

test("tenant failure cleanup preserves a pending engine change", async () => {
  const state = await getRuntimeConfigState(tdb.db);
  const saved = await saveRuntimeConfigPatch(tdb.db, {
    expected_revision: state.saved_revision,
    changes: { "log.level": "warn" },
    scope: "global",
    created_by: null,
  });
  await failRuntimeActivation(tdb.db, saved.saved_revision, "prepare rejected", tenantA);
  expect((await getRuntimeConfigState(tdb.db)).saved_revision).toBe(saved.saved_revision);
  await expect(assertNoPendingEngineChange(tdb.db)).rejects.toMatchObject({
    code: "operator_change_pending",
  });
});

test("late failure cleanup cannot mark an active revision failed", async () => {
  const state = await getRuntimeConfigState(tdb.db);
  await failRuntimeActivation(tdb.db, state.active_revision, "late timeout", tenantA);
  expect((await getRuntimeRevision(tdb.db, state.active_revision)).status).toBe("active");
  expect(await getRuntimeConfigState(tdb.db)).toEqual(state);
});

test("a replica NACK releases the failed tenant revision and preserves its diagnostic", async () => {
  const saved = await saveTenant();
  await tdb.db.insert(runtimeConfigReplicas).values({
    instance_id: "rejecting-replica",
    product_version: "test",
    last_seen_at: sql`NOW()`,
    active_revision: saved.active_revision,
  });
  const activating = activateRuntimeRevision(
    tdb.db,
    saved.saved_revision,
    { tenant_id: SYSTEM_TENANT_ID, actor_type: "system", actor_id: null, source: "test" },
    { restrict_to_tenant: tenantA },
  );
  await waitFor(
    async () => {
      const [replica] = await tdb.db
        .select()
        .from(runtimeConfigReplicas)
        .where(eq(runtimeConfigReplicas.instance_id, "rejecting-replica"));
      return replica?.desired_revision === saved.saved_revision;
    },
    { sleepMs: 10, label: "activation preparation" },
  );
  await tdb.db
    .update(runtimeConfigReplicas)
    .set({ ack_revision: saved.saved_revision, ack_status: "nack", ack_reason: "prepare rejected" })
    .where(eq(runtimeConfigReplicas.instance_id, "rejecting-replica"));
  expect((await activating).activation_status).toBe("failed");
  const revision = await getRuntimeRevision(tdb.db, saved.saved_revision);
  expect(revision.failure_reason).toBe("rejecting-replica: prepare rejected");
  await expect(assertNoPendingEngineChange(tdb.db)).resolves.toBeUndefined();
});
