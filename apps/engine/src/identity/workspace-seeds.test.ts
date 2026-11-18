import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, isNotNull } from "drizzle-orm";
import { knowledgeSources, notificationRules, skills } from "../db/schema/index.ts";
import { tenantWorkInFlight } from "../execution/tenant-work.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import { provisionSelfServiceTenant } from "./self-service.ts";
import { applyWorkspaceContentSeeds } from "./workspace-seeds.ts";

const uuid = createDeterministicUuidFactory(4127);
let ctx: HttpTestServer;
beforeAll(async () => {
  ctx = await createHttpTestServer("workspace-seeds");
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
});
afterAll(async () => {
  await waitFor(() => tenantWorkInFlight() === 0, {
    tries: 60_000,
    sleepMs: 2,
    label: "embedding of the seeded knowledge",
  });
  if (ctx) await ctx.cleanup();
}, 150_000);

const claims = (subject: string) => ({
  issuer_url: "https://identity.example.test",
  subject,
  email: `${subject}@example.test`,
  email_verified: true as const,
});

test("the inbox rule commits with the workspace; skill and knowledge seeds are an idempotent follow-up", async () => {
  const owned = await provisionSelfServiceTenant(
    claims("seeded-owner"),
    TEST_WORKSPACE_REGISTRATION,
    ctx.db,
  );
  const rules = () =>
    ctx.db
      .select()
      .from(notificationRules)
      .where(
        and(
          eq(notificationRules.tenant_id, owned.tenant.id),
          eq(notificationRules.target_workspace_id, "_cli"),
        ),
      );
  const seededSkills = () =>
    ctx.db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.tenant_id, owned.tenant.id), isNotNull(skills.seed_source)));
  const seededKnowledge = () =>
    ctx.db
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.tenant_id, owned.tenant.id),
          eq(knowledgeSources.source_type, "seed"),
        ),
      );
  expect(await rules()).toHaveLength(1);
  expect(await seededSkills()).toHaveLength(0);
  expect(await seededKnowledge()).toHaveLength(0);

  await applyWorkspaceContentSeeds(owned.tenant.id, ctx.db);
  const skillCount = (await seededSkills()).length;
  const knowledgeCount = (await seededKnowledge()).length;
  expect(skillCount).toBeGreaterThan(0);
  expect(knowledgeCount).toBeGreaterThan(0);

  await applyWorkspaceContentSeeds(owned.tenant.id, ctx.db);
  expect(await seededSkills()).toHaveLength(skillCount);
  expect(await seededKnowledge()).toHaveLength(knowledgeCount);
  expect(await rules()).toHaveLength(1);
});

test("a failing content seed never fails the caller, as at engine start", async () => {
  await expect(applyWorkspaceContentSeeds(uuid(), ctx.db)).resolves.toBeUndefined();
});
