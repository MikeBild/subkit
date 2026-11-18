import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  hostedTenantUsage,
  runtimeConfigRevisions,
  runtimeSecretVersions,
  tenants,
} from "../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { runWithTestEnv } from "../test-helpers/determinism/env.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import { HOSTED_WORKSPACE_ALLOWLIST } from "./hosted-workspace-allowlist.ts";
import { createSecretVersion, RuntimeConfigValidationError } from "./service.ts";

let ctx: HttpTestServer;
let tenantId: string;
const ids = createDeterministicUuidFactory(519);
beforeAll(async () => {
  ctx = await createHttpTestServer("tenant-runtime-secret-policy");
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
  tenantId = (
    await provisionSelfServiceTenant(
      {
        issuer_url: "https://identity.example.test",
        subject: "secret-policy",
        email: "secret-policy@example.test",
        email_verified: true,
      },
      TEST_WORKSPACE_REGISTRATION,
      ctx.db,
    )
  ).tenant.id;
});
afterAll(async () => {
  await ctx?.cleanup();
});

async function snapshot() {
  const [usage] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  const counts = await ctx.db.execute<{ secrets: number; revisions: number }>(
    sql`SELECT (SELECT count(*)::int FROM subkit.runtime_secret_versions) AS secrets,(SELECT count(*)::int FROM subkit.runtime_config_revisions) AS revisions`,
  );
  return { usage, counts: counts.rows[0] };
}

test("hosted neighbours, foreign secrets and unknown tenants fail before retaining ciphertext or revisions", async () => {
  const before = await snapshot();
  for (const name of [
    `tenants.${tenantId}.settings.llm.providers.anthropic.api_key`,
    `tenants.${tenantId}.settings.platform.slack.signing_secret`,
    `tenants.${tenantId}.settings.llm.api_key.backup`,
    `tenants.${ids()}.settings.llm.api_key`,
    "tenants.not-a-uuid.settings.llm.api_key",
  ]) {
    await expect(
      createSecretVersion(ctx.db, {
        name,
        value: "private-runtime-canary",
        created_by: ctx.userId,
      }),
    ).rejects.toThrow();
  }
  expect(await snapshot()).toEqual(before);
});

test("a hosted workspace may hold exactly its own model provider key", async () => {
  expect(HOSTED_WORKSPACE_ALLOWLIST).toEqual({
    settings: ["llm.provider", "llm.model", "llm.api_key"],
    secrets: ["llm.api_key"],
  });
  const own = await createSecretVersion(ctx.db, {
    name: `tenants.${tenantId}.settings.llm.api_key`,
    value: "workspace-own-key",
    created_by: ctx.userId,
  });
  expect(own.reference).toBe(`secret://tenants.${tenantId}.settings.llm.api_key/${own.version}`);
  // tenant-filter:exempt — the fixture reads the one secret version it just created by its exact name.
  const [stored] = await ctx.db
    .select({ tenant_id: runtimeSecretVersions.tenant_id })
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, own.name));
  expect(stored?.tenant_id).toBe(tenantId);
});

test("the database guard admits only the model provider key for a hosted workspace", async () => {
  const insert = (name: string) =>
    ctx.db.execute(
      sql`INSERT INTO subkit.runtime_secret_versions(name,version,ciphertext,iv,auth_tag) VALUES(${name},99,'\\x00','\\x00','\\x00')`,
    );
  for (const name of [
    `tenants.${tenantId}.settings.llm.providers.openai.api_key`,
    `tenants.${tenantId}.settings.platform.slack.signing_secret`,
  ]) {
    const refusal = await insert(name).then(
      () => null,
      (error: { cause?: { message?: string } }) => error.cause?.message ?? null,
    );
    expect(refusal).toBe("hosted_runtime_secret_overlay_forbidden");
  }
  await insert(`tenants.${tenantId}.settings.llm.api_key`);
});

test("production settings route cannot create orphan hosted secrets even at full quota", async () => {
  const before = await snapshot();
  await ctx.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${before.usage!.logical_bytes.toString()}::text)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
  const response = await runWithTestEnv({ NODE_ENV: "production" }, () =>
    fetch(`${ctx.baseUrl}/v1/settings/llm.api_key?tenant=${tenantId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ value: "private-runtime-canary", force: true }),
    }),
  );
  expect(response.status).toBe(422);
  const body = await response.text();
  expect(body).toContain("global policy");
  expect(body).not.toContain("private-runtime-canary");
  expect(await snapshot()).toEqual(before);
});

test("operator global and active selfhost secrets retain their existing creation path", async () => {
  const global = await createSecretVersion(ctx.db, {
    name: "settings.llm.api_key",
    value: "operator-secret",
    created_by: ctx.userId,
  });
  const local = await createSecretVersion(ctx.db, {
    name: `tenants.${ctx.tenantId}.settings.llm.api_key`,
    value: "selfhost-secret",
    created_by: ctx.userId,
  });
  expect(global.version).toBe(1);
  expect(local.version).toBe(1);
  expect(
    await ctx.db
      .select()
      .from(runtimeSecretVersions)
      .where(eq(runtimeSecretVersions.name, local.name)),
  ).toHaveLength(1);
  expect(
    await ctx.db
      .select()
      .from(runtimeConfigRevisions)
      .where(eq(runtimeConfigRevisions.status, "active")),
  ).toHaveLength(1);
});

test("inactive selfhost workspaces cannot retain new runtime secrets", async () => {
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({
      slug: "inactive-secret-fixture",
      display_name: "Inactive fixture",
      status: "suspended",
    })
    .returning();
  if (!tenant) throw new Error("inactive fixture missing");
  const before = await snapshot();
  await expect(
    createSecretVersion(ctx.db, {
      name: `tenants.${tenant.id}.settings.llm.api_key`,
      value: "inactive-private-secret",
      created_by: ctx.userId,
    }),
  ).rejects.toBeInstanceOf(RuntimeConfigValidationError);
  expect(await snapshot()).toEqual(before);
});
