import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  connectors,
  tenants,
  webhooksInbound,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  resolveWorkflowReviewEnvironment,
  workflowExecutionEnvironment,
} from "../execution-environment.ts";

let ctx: TestDb;
let counter = 0;
beforeAll(async () => {
  ctx = await createTestDb("execution_environment");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function tenantFixture() {
  const slug = `execution-environment-${++counter}`;
  const [tenant] = await ctx.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!tenant) throw new Error("missing tenant fixture");
  return tenant;
}

async function connectorFixture(
  tenant_id: string,
  slug: string,
  environment: "dev" | "prod",
  auth_type: "none" | "header" = "header",
) {
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug,
      display_name: slug,
      driver: "http",
      auth_type,
      environment,
      base_url: "https://api.example.test",
    })
    .returning();
  if (!connector) throw new Error("missing connector fixture");
  return connector;
}

async function workflowFixture(tenant_id: string, connector_ids: string[]) {
  const slug = `review-environment-${++counter}`;
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id, slug, name: slug, lifecycle: "draft" })
    .returning();
  if (!workflow) throw new Error("missing workflow fixture");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: slug,
        steps: connector_ids.map((connector_id, index) => ({
          id: `read_${index}`,
          kind: "request",
          method: "GET",
          connector_id,
          path: "/items",
        })),
      },
    })
    .returning();
  if (!version) throw new Error("missing version fixture");
  return { workflow, version };
}

async function scheduleFixture(tenant_id: string, workflow_id: string, mode: "dev" | "prod") {
  await ctx.db.insert(workflowsSchedules).values({
    tenant_id,
    workflow_id,
    cron: "0 9 * * *",
    timezone: "UTC",
    execution_mode: mode,
    input: {},
  });
}

test("prod-only connector bindings derive the prod review environment", async () => {
  const tenant = await tenantFixture();
  const briefing = await connectorFixture(tenant.id, "github-briefings-prod", "prod");
  const open = await connectorFixture(tenant.id, "public-feed", "prod", "none");
  const { workflow, version } = await workflowFixture(tenant.id, [briefing.id, open.id]);
  expect(
    await resolveWorkflowReviewEnvironment(ctx.db, tenant.id, workflow.id, {
      version_id: version.id,
    }),
  ).toEqual({ environment: "prod", source: "bindings" });
  expect(await workflowExecutionEnvironment(ctx.db, tenant.id, workflow.id)).toBe("dev");
});

test("dev and prod variants of the same slug keep the default", async () => {
  const tenant = await tenantFixture();
  const prod = await connectorFixture(tenant.id, "github", "prod");
  await connectorFixture(tenant.id, "github", "dev");
  const { workflow, version } = await workflowFixture(tenant.id, [prod.id]);
  expect(
    await resolveWorkflowReviewEnvironment(ctx.db, tenant.id, workflow.id, {
      version_id: version.id,
    }),
  ).toEqual({ environment: "dev", source: "default" });
});

test("mixed single-environment connectors keep the default", async () => {
  const tenant = await tenantFixture();
  const prod = await connectorFixture(tenant.id, "github-prod", "prod");
  const dev = await connectorFixture(tenant.id, "mailer-dev", "dev");
  const { workflow, version } = await workflowFixture(tenant.id, [prod.id, dev.id]);
  expect(
    await resolveWorkflowReviewEnvironment(ctx.db, tenant.id, workflow.id, {
      version_id: version.id,
    }),
  ).toEqual({ environment: "dev", source: "default" });
});

test("a schedule wins over connector bindings", async () => {
  const tenant = await tenantFixture();
  const prod = await connectorFixture(tenant.id, "github-briefings-prod", "prod");
  const { workflow, version } = await workflowFixture(tenant.id, [prod.id]);
  await scheduleFixture(tenant.id, workflow.id, "dev");
  expect(
    await resolveWorkflowReviewEnvironment(ctx.db, tenant.id, workflow.id, {
      version_id: version.id,
    }),
  ).toEqual({ environment: "dev", source: "schedule" });
});

test("a dev schedule and a prod hook stay ambiguous", async () => {
  const tenant = await tenantFixture();
  const prod = await connectorFixture(tenant.id, "github-briefings-prod", "prod");
  const { workflow, version } = await workflowFixture(tenant.id, [prod.id]);
  await scheduleFixture(tenant.id, workflow.id, "dev");
  await ctx.db.insert(webhooksInbound).values({
    tenant_id: tenant.id,
    workflow_id: workflow.id,
    slug: `${workflow.slug}-hook`,
    verifier: "standard",
    secret_ciphertext: Buffer.alloc(1),
    secret_iv: Buffer.alloc(1),
    secret_auth_tag: Buffer.alloc(1),
  });
  await expect(
    resolveWorkflowReviewEnvironment(ctx.db, tenant.id, workflow.id, { version_id: version.id }),
  ).rejects.toMatchObject({ code: "workflow_environment_ambiguous" });
});

test("another tenant's connector rows are never read", async () => {
  const tenant = await tenantFixture();
  const other = await tenantFixture();
  const prod = await connectorFixture(tenant.id, "shared-slug", "prod");
  await connectorFixture(other.id, "shared-slug", "dev");
  const foreign = await connectorFixture(other.id, "foreign-dev", "dev");
  const own = await workflowFixture(tenant.id, [prod.id]);
  expect(
    await resolveWorkflowReviewEnvironment(ctx.db, tenant.id, own.workflow.id, {
      version_id: own.version.id,
    }),
  ).toEqual({ environment: "prod", source: "bindings" });
  const crossed = await workflowFixture(tenant.id, [foreign.id]);
  expect(
    await resolveWorkflowReviewEnvironment(ctx.db, tenant.id, crossed.workflow.id, {
      version_id: crossed.version.id,
    }),
  ).toEqual({ environment: "dev", source: "default" });
  expect(
    await resolveWorkflowReviewEnvironment(ctx.db, other.id, own.workflow.id, {
      version_id: own.version.id,
    }),
  ).toEqual({ environment: "dev", source: "default" });
});
