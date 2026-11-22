import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, like } from "drizzle-orm";
import { SYSTEM_TENANT_ID } from "../audit/types.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../config/loader.ts";
import { auditLog, runtimeConfigReplicas, runtimeSecretVersions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { testEnv } from "../test-helpers/determinism/env.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import { RuntimeConfigCoordinator } from "./coordinator.ts";
import { persistLlmAccess } from "./llm-access.ts";
import { pendingRuntimeChange, waitOutWorkspaceChange } from "./pending-engine-change.ts";
import {
  activateRuntimeRevision,
  getRuntimeConfigState,
  getRuntimeRevision,
  initializeRuntimeConfig,
  RuntimeConfigConflictError,
  RuntimeConfigPendingError,
  saveRuntimeConfigPatch,
} from "./service.ts";

const SYSTEM_ACTOR = {
  tenant_id: SYSTEM_TENANT_ID,
  actor_type: "system" as const,
  actor_id: null,
  source: "test",
};

let tdb: TestDb;
let first: string;
let second: string;
let configDir: string;
let coordinator: RuntimeConfigCoordinator;

async function workspace(subject: string): Promise<string> {
  const provisioned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject,
      email: `${subject}@example.test`,
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    tdb.db,
  );
  return provisioned.tenant.id;
}

beforeAll(async () => {
  testEnv.MASTER_KEY = "66".repeat(32);
  tdb = await createTestDb("llm-access");
  await configureHostedPolicyForTests(tdb.db, tdb.url);
  first = await workspace("first-owner");
  second = await workspace("second-owner");
  configDir = mkdtempSync(join(tmpdir(), "subkit-llm-access-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  await initializeRuntimeConfig(tdb.db, getConfig());
  coordinator = new RuntimeConfigCoordinator(tdb.db, "test", "llm-access-replica");
  await coordinator.start();
});

afterAll(async () => {
  await coordinator.stop();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  await tdb.cleanup();
});

function store(tenantId: string, apiKey: string) {
  return persistLlmAccess(tdb.db, {
    tenant_id: tenantId,
    restricted: true,
    change: { provider: "openai", model: "", api_key: apiKey },
    actor: { tenant_id: tenantId, actor_type: "system", actor_id: null },
    source: "test",
  });
}

function keyVersions(tenantId: string) {
  // tenant-filter:exempt — the fixture reads one workspace's versions from the product-global secret registry.
  return tdb.db
    .select({ version: runtimeSecretVersions.version })
    .from(runtimeSecretVersions)
    .where(like(runtimeSecretVersions.name, `tenants.${tenantId}.%`))
    .orderBy(runtimeSecretVersions.version);
}

async function removedVersions(tenantId: string) {
  const rows = await tdb.db
    .select({ reason: auditLog.reason })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "secret.version_revoked")));
  return rows.map((row) => row.reason);
}

test("two workspaces that store their keys at the same moment both succeed", async () => {
  await Promise.all([store(first, "sk-first-own-key"), store(second, "sk-second-own-key")]);
  const state = await getRuntimeConfigState(tdb.db);
  expect(state.saved_revision).toBe(state.active_revision);
  expect(getConfig(first).llm.providers.openai.api_key).toBe("sk-first-own-key");
  expect(getConfig(second).llm.providers.openai.api_key).toBe("sk-second-own-key");
  expect(await keyVersions(first)).toEqual([{ version: 1 }]);
  expect(await keyVersions(second)).toEqual([{ version: 1 }]);
});

test("replacing a workspace key removes the previous key version", async () => {
  await store(first, "sk-first-replacement");
  expect(getConfig(first).llm.providers.openai.api_key).toBe("sk-first-replacement");
  expect(await keyVersions(first)).toEqual([{ version: 2 }]);
  expect(await removedVersions(first)).toEqual(["superseded"]);
  const state = await getRuntimeConfigState(tdb.db);
  const active = await getRuntimeRevision(tdb.db, state.active_revision);
  expect(JSON.stringify(active.document)).toContain(
    `secret://tenants.${first}.settings.llm.api_key/2`,
  );
});

test("another workspace's unfinished change is waited out, an engine change is refused at once", async () => {
  const state = await getRuntimeConfigState(tdb.db);
  const inFlight = await saveRuntimeConfigPatch(tdb.db, {
    expected_revision: state.saved_revision,
    changes: { "llm.model": "gpt-in-flight" },
    scope: "tenant",
    tenant_id: second,
    created_by: null,
    restrict_to_tenant: second,
  });
  expect(await pendingRuntimeChange(tdb.db)).toBe("workspace");
  const waiting = store(first, "sk-first-after-wait");
  await activateRuntimeRevision(tdb.db, inFlight.saved_revision, SYSTEM_ACTOR, {
    restrict_to_tenant: second,
  });
  await waiting;
  expect(getConfig(first).llm.providers.openai.api_key).toBe("sk-first-after-wait");

  const settled = await getRuntimeConfigState(tdb.db);
  const engine = await saveRuntimeConfigPatch(tdb.db, {
    expected_revision: settled.saved_revision,
    changes: { "log.level": "warn" },
    scope: "global",
    created_by: null,
  });
  expect(await pendingRuntimeChange(tdb.db)).toBe("engine");
  const before = await keyVersions(first);
  await expect(store(first, "sk-first-while-pending")).rejects.toBeInstanceOf(
    RuntimeConfigPendingError,
  );
  expect(await keyVersions(first)).toEqual(before);
  await activateRuntimeRevision(tdb.db, engine.saved_revision, SYSTEM_ACTOR);
  expect(await pendingRuntimeChange(tdb.db)).toBe("none");
});

test("a workspace change that never finishes ends the wait as a pending change", async () => {
  const state = await getRuntimeConfigState(tdb.db);
  const stuck = await saveRuntimeConfigPatch(tdb.db, {
    expected_revision: state.saved_revision,
    changes: { "llm.model": "gpt-stuck" },
    scope: "tenant",
    tenant_id: second,
    created_by: null,
    restrict_to_tenant: second,
  });
  await expect(waitOutWorkspaceChange(tdb.db, [5, 5])).rejects.toBeInstanceOf(
    RuntimeConfigPendingError,
  );
  await activateRuntimeRevision(tdb.db, stuck.saved_revision, SYSTEM_ACTOR, {
    restrict_to_tenant: second,
  });
});

test("a key whose activation fails leaves no key version behind", async () => {
  await coordinator.stop();
  // tenant-filter:exempt — replica leases are product-global runtime state.
  await tdb.db.update(runtimeConfigReplicas).set({ last_seen_at: new Date(0) });
  const before = await keyVersions(second);
  await expect(store(second, "sk-second-not-activated")).rejects.toBeInstanceOf(
    RuntimeConfigConflictError,
  );
  expect(await keyVersions(second)).toEqual(before);
  expect(await removedVersions(second)).toEqual(["not_activated"]);
  expect(getConfig(second).llm.providers.openai.api_key).toBe("sk-second-own-key");
  const state = await getRuntimeConfigState(tdb.db);
  expect(state.saved_revision).toBe(state.active_revision);
});
