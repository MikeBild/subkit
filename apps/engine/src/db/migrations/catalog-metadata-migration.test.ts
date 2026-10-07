import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  connectors,
  knowledgeSources,
  tenants,
  workflows,
  workflowVersions,
} from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

let testDb: TestDb;
let tenantId: string;
let otherTenantId: string;

const migration = EMBEDDED_MIGRATIONS.find((m) => m.tag === "0082_catalog_metadata");

async function runBackfill(): Promise<void> {
  if (!migration) throw new Error("migration 0082_catalog_metadata is not embedded");
  const backfill = migration.statements.filter((s) => /^\s*(UPDATE|WITH)\b/i.test(s));
  expect(backfill.length).toBeGreaterThan(0);
  for (const statement of backfill) await testDb.db.execute(sql.raw(statement));
}

async function seedWorkflow(tenant: string, slug: string, dagDescription?: string) {
  const [wf] = await testDb.db
    .insert(workflows)
    .values({ tenant_id: tenant, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!wf) throw new Error(`seed ${slug} failed`);
  const [v] = await testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenant,
      workflow_id: wf.id,
      version: 1,
      dag: { name: slug, steps: [], ...(dagDescription ? { description: dagDescription } : {}) },
    })
    .returning();
  await testDb.db
    .update(workflows)
    .set({ current_version_id: v?.id })
    .where(eq(workflows.id, wf.id));
  return wf.id;
}

async function workflowRow(slug: string, tenant = tenantId) {
  const rows = await testDb.db.select().from(workflows).where(eq(workflows.slug, slug));
  const row = rows.find((r) => r.tenant_id === tenant);
  if (!row) throw new Error(`missing ${slug}`);
  return row;
}

beforeAll(async () => {
  testDb = await createTestDb("catalog_metadata_migration");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-catalog-migration", display_name: "catalog" })
    .returning();
  const [o] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-catalog-migration-other", display_name: "other" })
    .returning();
  if (!t || !o) throw new Error("seed tenants failed");
  tenantId = t.id;
  otherTenantId = o.id;

  for (const slug of [
    "reports-daily-sales",
    "reports-weekly-sales",
    "reports-monthly-sales",
    "reports-rollup-daily",
    "reports-rollup-weekly",
    "reports-rollup-monthly",
    "notes-sync",
    "notes-export",
    "lonely-probe",
  ]) {
    await seedWorkflow(tenantId, slug);
  }
  await seedWorkflow(tenantId, "described-in-definition", "Sends the weekly sales digest.");
  for (const slug of ["notes-a", "notes-b", "notes-c"]) await seedWorkflow(otherTenantId, slug);

  await testDb.db.insert(connectors).values([
    {
      tenant_id: tenantId,
      slug: "crm-api",
      display_name: "CRM API",
      driver: "http",
      template_slug: "crm-template",
      template_snapshot: { category: "crm" },
    },
    {
      tenant_id: tenantId,
      slug: "custom-api",
      display_name: "Custom API",
      driver: "http",
      template_snapshot: { category: "custom" },
    },
    {
      tenant_id: tenantId,
      slug: "plain-api",
      display_name: "Plain API",
      driver: "http",
      description: "Reads invoices from the billing system.",
    },
  ]);

  await testDb.db.insert(knowledgeSources).values([
    {
      tenant_id: tenantId,
      name: "Handbook",
      slug: "handbook",
      description: "How support answers refund questions.",
      tags: ["kind:guide", "support", "refunds"],
      source_type: "inline",
      source_uri: "inline:handbook",
      version: "1",
    },
    {
      tenant_id: tenantId,
      name: "https://api.example.test",
      slug: "discovery-url-0001",
      description: "Endpoint index discovered from https://api.example.test",
      tags: [],
      source_type: "discovery",
      source_uri: "https://api.example.test",
      version: "1",
    },
  ]);

  await runBackfill();
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("0082 catalog metadata backfill", () => {
  test("a slug family of at least three becomes the stored category a person chose", async () => {
    const daily = await workflowRow("reports-rollup-daily");
    expect(daily.category).toBe("reports");
    expect(daily.category_source).toBe("human");
  });

  test("a family below three stays in the catch-all for automatic description", async () => {
    const notes = await workflowRow("notes-sync");
    expect(notes.category).toBe("other");
    expect(notes.category_source).toBe("llm");
    expect((await workflowRow("lonely-probe")).category).toBe("other");
  });

  test("families are counted per tenant, never across tenants", async () => {
    expect((await workflowRow("notes-a", otherTenantId)).category).toBe("notes");
    expect((await workflowRow("notes-export")).category).toBe("other");
  });

  test("a description that only lived in the definition moves to the column as a person's text", async () => {
    const row = await workflowRow("described-in-definition");
    expect(row.description).toBe("Sends the weekly sales digest.");
    expect(row.description_source).toBe("human");
  });

  test("a connector takes the semantic category of its template, never the placeholder one", async () => {
    const rows = await testDb.db
      .select()
      .from(connectors)
      .where(eq(connectors.tenant_id, tenantId));
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    expect(bySlug.get("crm-api")?.category).toBe("crm");
    expect(bySlug.get("crm-api")?.category_source).toBe("llm");
    expect(bySlug.get("custom-api")?.category).toBe("other");
    expect(bySlug.get("plain-api")?.description_source).toBe("human");
  });

  test("a knowledge source takes its first topic tag and keeps a person's description", async () => {
    const rows = await testDb.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.tenant_id, tenantId));
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    expect(bySlug.get("handbook")?.category).toBe("support");
    expect(bySlug.get("handbook")?.description_source).toBe("human");
  });

  test("an automatic endpoint index stays open for a better description", async () => {
    const [row] = await testDb.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.slug, "discovery-url-0001"));
    expect(row?.description_source).toBe("llm");
    expect(row?.category).toBe("other");
  });

  test("running the backfill twice changes nothing", async () => {
    const before = await testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.tenant_id, tenantId));
    await runBackfill();
    const after = await testDb.db.select().from(workflows).where(eq(workflows.tenant_id, tenantId));
    const shape = (rows: typeof before) =>
      rows
        .map((r) => `${r.slug}:${r.category}:${r.category_source}:${r.description_source}`)
        .sort();
    expect(shape(after)).toEqual(shape(before));
  });
});
