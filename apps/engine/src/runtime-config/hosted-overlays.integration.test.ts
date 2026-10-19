import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_TENANT_ID } from "../audit/types.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../config/loader.ts";
import { runtimeConfigRevisions, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { configDigest } from "./document.ts";
import {
  activateRuntimeRevision,
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
  tdb = await createTestDb("hosted-runtime-policy");
  await configureHostedPolicyForTests(tdb.db, tdb.url);
  const provisioned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "runtime-owner",
      email: "owner@example.test",
      email_verified: true,
    },
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
