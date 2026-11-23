import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectors, dataMigrations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { PROBE_PATH_V1_BACKFILL_NAME, runProbePathV1Backfill } from "./probe-path-v1.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("connector_probe_path_v1");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

const probe = (path: string) => ({ method: "GET", path, expected_status: [200, 200] });

async function seed(tenantId: string, slug: string, template: string | null, path: string) {
  const [row] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug,
      display_name: slug,
      driver: "http",
      auth_type: "none",
      environment: "dev",
      base_url: "https://service.example.test",
      template_slug: template,
      config: { probe_endpoint: probe(path), timeout_ms: 5000 },
    })
    .returning({ id: connectors.id });
  if (!row) throw new Error("missing connector");
  return row.id;
}

async function probePath(tenantId: string, id: string): Promise<unknown> {
  const [row] = await ctx.db
    .select({ config: connectors.config })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.id, id)));
  return row?.config;
}

test("existing jira and salesforce connectors move to the new probe path once", async () => {
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "probe-path", display_name: "Probe path" })
    .returning();
  if (!tenant) throw new Error("missing tenant");
  const jira = await seed(tenant.id, "jira", "jira", "/rest/api/3/myself");
  const salesforce = await seed(tenant.id, "salesforce", "salesforce", "/services/data");
  const custom = await seed(tenant.id, "jira-custom", "jira", "/rest/api/3/serverInfo");
  const other = await seed(tenant.id, "other", null, "/services/data");

  expect(await runProbePathV1Backfill(ctx.db)).toEqual({ skipped: false, rewritten: 2 });

  expect(await probePath(tenant.id, jira)).toEqual({
    probe_endpoint: probe("/myself"),
    timeout_ms: 5000,
  });
  expect(await probePath(tenant.id, salesforce)).toEqual({
    probe_endpoint: probe("/sobjects"),
    timeout_ms: 5000,
  });
  expect(await probePath(tenant.id, custom)).toEqual({
    probe_endpoint: probe("/rest/api/3/serverInfo"),
    timeout_ms: 5000,
  });
  expect(await probePath(tenant.id, other)).toEqual({
    probe_endpoint: probe("/services/data"),
    timeout_ms: 5000,
  });

  const markers = await ctx.db
    .select({ name: dataMigrations.name })
    .from(dataMigrations)
    .where(eq(dataMigrations.name, PROBE_PATH_V1_BACKFILL_NAME));
  expect(markers).toHaveLength(1);
  expect(await runProbePathV1Backfill(ctx.db)).toEqual({ skipped: true, rewritten: 0 });
});
