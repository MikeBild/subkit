import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { connectors, files, tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

let testDb: TestDb;
let tenantId: string;
let otherTenantId: string;

const migration = EMBEDDED_MIGRATIONS.find((m) => m.tag === "0083_catalog_describe_refresh");
const described = new Date("2026-10-01T00:00:00Z");

async function runMigration(): Promise<void> {
  if (!migration) throw new Error("migration 0083_catalog_describe_refresh is not embedded");
  for (const statement of migration.statements) await testDb.db.execute(sql.raw(statement));
}

async function seedFile(
  tenant: string,
  name: string,
  over: Partial<typeof files.$inferInsert> = {},
) {
  const [row] = await testDb.db
    .insert(files)
    .values({
      tenant_id: tenant,
      filename: name,
      content_type: "text/plain",
      storage_uri: `s3://bucket/${name}`,
      status: "ready",
      catalog_described_at: described,
      ...over,
    })
    .returning();
  return row!.id;
}

async function seedConnector(
  tenant: string,
  slug: string,
  environment: "dev" | "prod",
  createdAt: string,
  over: Partial<typeof connectors.$inferInsert> = {},
) {
  const [row] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenant,
      slug,
      display_name: `${slug} ${environment}`,
      driver: "http",
      environment,
      auth_type: "bearer",
      base_url: "https://x.example.test",
      created_at: new Date(createdAt),
      catalog_described_at: described,
      ...over,
    })
    .returning();
  return row!.id;
}

async function describedAt(table: typeof files | typeof connectors, id: string) {
  const [row] = await testDb.db
    .select({ at: table.catalog_described_at })
    .from(table)
    .where(eq(table.id, id));
  return row?.at ?? null;
}

beforeAll(async () => {
  testDb = await createTestDb("catalog_describe_refresh");
  const [a] = await testDb.db
    .insert(tenants)
    .values({ slug: "refresh-a", display_name: "A" })
    .returning();
  const [b] = await testDb.db
    .insert(tenants)
    .values({ slug: "refresh-b", display_name: "B" })
    .returning();
  tenantId = a!.id;
  otherTenantId = b!.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("0083 catalog describe refresh", () => {
  test("releases every live file the assistant wrote about, and no other", async () => {
    const llm = await seedFile(tenantId, "llm.md");
    const categoryOnly = await seedFile(tenantId, "cat.md", { description_source: "human" });
    const human = await seedFile(tenantId, "human.md", {
      description_source: "human",
      category_source: "human",
    });
    const deleted = await seedFile(tenantId, "deleted.md", {
      deleted_at: new Date("2026-10-02T00:00:00Z"),
    });
    await runMigration();
    expect(await describedAt(files, llm)).toBeNull();
    expect(await describedAt(files, categoryOnly)).toBeNull();
    expect(await describedAt(files, human)).toEqual(described);
    expect(await describedAt(files, deleted)).toEqual(described);
  });

  test("releases only the connectors whose category differs from the oldest of their slug", async () => {
    const oldest = await seedConnector(tenantId, "agent", "prod", "2026-01-01T00:00:00Z", {
      category: "wikikit",
    });
    const differs = await seedConnector(tenantId, "agent", "dev", "2026-02-01T00:00:00Z", {
      category: "mikebild-dev",
    });
    const alone = await seedConnector(tenantId, "solo", "prod", "2026-01-01T00:00:00Z", {
      category: "solo",
    });
    const same = await seedConnector(tenantId, "twin", "dev", "2026-02-01T00:00:00Z", {
      category: "twin",
    });
    await seedConnector(tenantId, "twin", "prod", "2026-01-01T00:00:00Z", { category: "twin" });
    const human = await seedConnector(tenantId, "kept", "dev", "2026-02-01T00:00:00Z", {
      category: "mine",
      category_source: "human",
    });
    await seedConnector(tenantId, "kept", "prod", "2026-01-01T00:00:00Z", { category: "other" });
    const foreignOldest = await seedConnector(
      otherTenantId,
      "agent",
      "prod",
      "2025-01-01T00:00:00Z",
      { category: "elsewhere" },
    );
    const ownYounger = await seedConnector(tenantId, "agent2", "dev", "2026-03-01T00:00:00Z", {
      category: "agent2",
    });
    await runMigration();
    expect(await describedAt(connectors, differs)).toBeNull();
    expect(await describedAt(connectors, oldest)).toEqual(described);
    expect(await describedAt(connectors, alone)).toEqual(described);
    expect(await describedAt(connectors, same)).toEqual(described);
    expect(await describedAt(connectors, human)).toEqual(described);
    expect(await describedAt(connectors, foreignOldest)).toEqual(described);
    expect(await describedAt(connectors, ownYounger)).toEqual(described);
  });
});
