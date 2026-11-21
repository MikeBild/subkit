import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_TENANT_ID } from "../audit/types.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../config/loader.ts";
import { runtimeConfigRevisions, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { workspaceAiAccess } from "../llm/runtime/workspace-access.ts";
import { testEnv } from "../test-helpers/determinism/env.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import { RuntimeConfigCoordinator } from "./coordinator.ts";
import { configDigest } from "./document.ts";
import { persistLlmAccess } from "./llm-access.ts";
import {
  activateRuntimeRevision,
  createSecretVersion,
  getRuntimeConfigState,
  getRuntimeRevision,
  initializeRuntimeConfig,
  prepareRuntimeConfig,
  RuntimeConfigValidationError,
  saveRuntimeConfigPatch,
} from "./service.ts";

let tdb: TestDb;
let hostedTenant: string;
let ordinaryTenant: string;
let configDir: string;

beforeAll(async () => {
  testEnv.MASTER_KEY = "66".repeat(32);
  tdb = await createTestDb("hosted-runtime-policy");
  await configureHostedPolicyForTests(tdb.db, tdb.url);
  const provisioned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "runtime-owner",
      email: "owner@example.test",
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    tdb.db,
  );
  hostedTenant = provisioned.tenant.id;
  const [ordinary] = await tdb.db
    .insert(tenants)
    .values({ slug: "ordinary", display_name: "Ordinary" })
    .returning();
  if (!ordinary) throw new Error("ordinary tenant fixture missing");
  ordinaryTenant = ordinary.id;
  configDir = mkdtempSync(join(tmpdir(), "sk-hosted-runtime-policy-"));
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

for (const restricted of [true, false]) {
  test(`hosted overlays are forbidden for ${restricted ? "tenant" : "engine"} writers`, async () => {
    const state = await getRuntimeConfigState(tdb.db);
    await expect(
      saveRuntimeConfigPatch(tdb.db, {
        expected_revision: state.saved_revision,
        scope: "tenant",
        tenant_id: hostedTenant,
        changes: { "llm.model": "unfunded-model" },
        created_by: null,
        ...(restricted ? { restrict_to_tenant: hostedTenant } : {}),
      }),
    ).rejects.toBeInstanceOf(RuntimeConfigValidationError);
    expect(await getRuntimeConfigState(tdb.db)).toEqual(state);
  });
}

test("an injected stored overlay cannot prepare or activate", async () => {
  const state = await getRuntimeConfigState(tdb.db);
  const active = await getRuntimeRevision(tdb.db, state.active_revision);
  const document = {
    ...active.document,
    tenants: { [hostedTenant]: { llm: { model: "unfunded-model" } } },
  };
  const [revision] = await tdb.db
    .insert(runtimeConfigRevisions)
    .values({ document, digest: configDigest(document) })
    .returning();
  if (!revision) throw new Error("revision fixture missing");
  await expect(prepareRuntimeConfig(tdb.db, revision)).rejects.toBeInstanceOf(
    RuntimeConfigValidationError,
  );
  await expect(
    activateRuntimeRevision(tdb.db, revision.revision, {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      actor_id: null,
      source: "test",
    }),
  ).rejects.toBeInstanceOf(RuntimeConfigValidationError);
  expect(await getRuntimeConfigState(tdb.db)).toEqual(state);
});

test("startup cannot persist a self-service overlay from a seed document", async () => {
  const state = await getRuntimeConfigState(tdb.db);
  await expect(
    initializeRuntimeConfig(tdb.db, {
      ...getConfig(),
      tenants: { [hostedTenant]: { llm: { model: "unfunded-model" } } },
    }),
  ).rejects.toBeInstanceOf(RuntimeConfigValidationError);
  expect(await getRuntimeConfigState(tdb.db)).toEqual(state);
});

test("ordinary self-hosted tenant settings remain available", async () => {
  const state = await getRuntimeConfigState(tdb.db);
  const saved = await saveRuntimeConfigPatch(tdb.db, {
    expected_revision: state.saved_revision,
    scope: "tenant",
    tenant_id: ordinaryTenant,
    changes: { "llm.model": "ordinary-model" },
    created_by: null,
    restrict_to_tenant: ordinaryTenant,
  });
  const revision = await getRuntimeRevision(tdb.db, saved.saved_revision);
  expect(revision.document.tenants).toEqual({
    [ordinaryTenant]: { llm: { model: "ordinary-model" } },
  });
});

test("a hosted workspace overlay holds exactly its own provider, model and key", async () => {
  const state = await getRuntimeConfigState(tdb.db);
  const secret = await createSecretVersion(tdb.db, {
    name: `tenants.${hostedTenant}.settings.llm.api_key`,
    value: "workspace-own-key",
    created_by: null,
  });
  const own = {
    "llm.provider": "anthropic",
    "llm.model": "claude-haiku-4-5",
    "llm.api_key": secret.reference,
  };
  const patch = (changes: Record<string, unknown>) =>
    saveRuntimeConfigPatch(tdb.db, {
      expected_revision: state.saved_revision,
      scope: "tenant",
      tenant_id: hostedTenant,
      changes,
      created_by: null,
    });
  for (const neighbour of [
    { "llm.fallback_provider": "openai" },
    { "llm.summarize_model": "claude-haiku-4-5" },
    { "llm.web_search": true },
    { "connectors.mcp.per_server_manifest_byte_cap": 1000 },
  ]) {
    await expect(patch({ ...own, ...neighbour })).rejects.toBeInstanceOf(
      RuntimeConfigValidationError,
    );
  }
  await expect(patch({ "llm.provider": "anthropic" })).rejects.toBeInstanceOf(
    RuntimeConfigValidationError,
  );
  expect(await getRuntimeConfigState(tdb.db)).toEqual(state);
  const saved = await patch(own);
  const revision = await getRuntimeRevision(tdb.db, saved.saved_revision);
  expect((revision.document.tenants as Record<string, unknown>)[hostedTenant]).toEqual({
    llm: { provider: "anthropic", model: "claude-haiku-4-5", api_key: secret.reference },
  });
  expect((await prepareRuntimeConfig(tdb.db, revision)).tenants[hostedTenant]?.llm?.api_key).toBe(
    "workspace-own-key",
  );
});

test("storing a hosted workspace's model access activates it through the revision service", async () => {
  const coordinator = new RuntimeConfigCoordinator(tdb.db, "test", "hosted-access-replica");
  await coordinator.start();
  try {
    const pending = await getRuntimeConfigState(tdb.db);
    await activateRuntimeRevision(tdb.db, pending.saved_revision, {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      actor_id: null,
      source: "test",
    });
    await persistLlmAccess(tdb.db, {
      tenant_id: hostedTenant,
      restricted: true,
      change: { provider: "openai", model: "", api_key: "sk-activated-own-key" },
      actor: { tenant_id: hostedTenant, actor_type: "system", actor_id: null },
      source: "test",
    });
  } finally {
    await coordinator.stop();
  }
  const state = await getRuntimeConfigState(tdb.db);
  expect(state.saved_revision).toBe(state.active_revision);
  expect(getConfig(hostedTenant).llm.providers.openai.api_key).toBe("sk-activated-own-key");
  expect(workspaceAiAccess({ id: hostedTenant, origin: "self_service" })).toEqual({
    configured: true,
    provider: "openai",
    model: null,
    own_key: true,
  });
  const active = await getRuntimeRevision(tdb.db, state.active_revision);
  expect(JSON.stringify(active.document)).not.toContain("sk-activated-own-key");
});
