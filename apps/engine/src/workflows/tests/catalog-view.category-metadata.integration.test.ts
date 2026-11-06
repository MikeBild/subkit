import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { lockCatalogVocabulary } from "../../db/catalog-vocabulary.ts";
import { catalogCategories, connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { describePendingCategoryPurposes } from "../catalog-describe.ts";
import { loadCategoryVocabulary, renameCategory } from "../catalog-view.ts";
import { catalogViewFixtures } from "./catalog-view-fixtures.ts";

let ctx: TestDb;

let tenant_id = "";

let apiConnectorId = "";

const { seedConnector, seedWorkflow } = catalogViewFixtures({
  get ctx() {
    return ctx;
  },
  get tenant_id() {
    return tenant_id;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("workflows_catalog_view");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-catalog-view", display_name: "Catalog" })
    .returning();
  tenant_id = t!.id;

  apiConnectorId = await seedConnector("billing-api");
  await seedConnector("unused-api");

  for (const name of ["search-pages", "append-markdown", "page-properties"]) {
    await seedWorkflow(
      `notion-${name}`,
      {
        id: "s1",
        kind: "request",
        method: "GET",
        url: "https://notion.example.test/x",
      },
      "notion",
    );
  }
  for (const name of ["by-date", "tomorrow"]) {
    await seedWorkflow(`berlin-weather-${name}`, {
      id: "s1",
      kind: "request",
      method: "GET",
      url: "https://weather.example.test/x",
    });
  }

  await seedWorkflow("billing-by-id", {
    id: "s1",
    kind: "request",
    connector_id: apiConnectorId,
    method: "GET",
    path: "/invoices",
  });
  await seedWorkflow("billing-by-placeholder", {
    id: "s1",
    kind: "request",
    method: "GET",
    url: "${connector.billing-api.base_url}/invoices",
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("category metadata compare and swap", () => {
  test("a stale source or target cannot overwrite human purpose", async () => {
    await ctx.db.insert(catalogCategories).values([
      {
        tenant_id,
        name: "source-swap",
        purpose: "Original",
        purpose_source: "human",
      },
      {
        tenant_id,
        name: "target-swap",
        purpose: "Target retained",
        purpose_source: "human",
        aliases: ["Existing"],
      },
    ]);
    await ctx.db.insert(connectors).values({
      tenant_id,
      slug: "source-swap-fixture",
      display_name: "Source",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
      category: "source-swap",
    });
    const input = {
      tenant_id,
      from: "source-swap",
      to: "target-swap",
      purpose: "Ignored on merge",
      aliases: ["Alternate"],
      expected_source_revision: 1,
      expected_target_revision: 1,
    };
    await expect(
      renameCategory({ ...input, expected_source_revision: null }, ctx.db),
    ).rejects.toThrow("changed");
    await expect(
      renameCategory({ ...input, expected_target_revision: null }, ctx.db),
    ).rejects.toThrow("changed");
    const merged = await renameCategory(input, ctx.db);
    expect(merged.metadata.purpose).toBe("Target retained");
    expect(merged.metadata.purpose_source).toBe("human");
    expect(merged.metadata.aliases).toEqual(["Existing", "Alternate", "source-swap"]);
    const back = await renameCategory(
      {
        ...input,
        from: "target-swap",
        to: "source-swap",
        purpose: "Renamed back",
        expected_source_revision: merged.metadata.revision,
        expected_target_revision: null,
      },
      ctx.db,
    );
    expect(back.metadata.purpose).toBe("Renamed back");
    const [connector] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id,
        slug: "redirect-check",
        display_name: "Redirect",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://example.test",
        category: "target-swap",
      })
      .returning();
    expect(connector?.category).toBe("source-swap");
    if (!connector) throw new Error("Connector missing");
    await ctx.db
      .update(connectors)
      .set({ deleted_at: new Date("2020-01-01T00:00:00Z") })
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, connector.id)));
    await renameCategory(
      {
        ...input,
        from: "source-swap",
        to: "final-swap",
        purpose: "Final",
        expected_source_revision: back.metadata.revision,
        expected_target_revision: null,
      },
      ctx.db,
    );
    const [restored] = await ctx.db
      .update(connectors)
      .set({ deleted_at: null, category: "target-swap" })
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, connector.id)))
      .returning();
    expect(restored?.category).toBe("final-swap");
  });
});

describe("category generation and assignment isolation", () => {
  test("generation uses only shared input and loses to human revision", async () => {
    await ctx.db.insert(catalogCategories).values({
      tenant_id,
      name: "purpose-race",
      aliases: ["Shared alias"],
      purpose_pending: true,
    });
    await ctx.db.insert(connectors).values({
      tenant_id,
      slug: "purpose-race",
      display_name: "Private connector text",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
      category: "purpose-race",
    });
    await describePendingCategoryPurposes(tenant_id, ctx.db, 100, async (tenant, name, aliases) => {
      if (name !== "purpose-race") return null;
      expect(tenant).toBe(tenant_id);
      expect(aliases).toEqual(["Shared alias"]);
      await renameCategory(
        {
          tenant_id,
          from: name,
          to: name,
          purpose: "A person decided",
          aliases: ["Human alias"],
          expected_source_revision: 1,
          expected_target_revision: 1,
        },
        ctx.db,
      );
      return "Stale generated purpose";
    });
    const result = (await loadCategoryVocabulary(tenant_id, ctx.db)).find(
      (row) => row.category === "purpose-race",
    );
    expect(result?.purpose).toBe("A person decided");
    expect(result?.purpose_source).toBe("human");
  });

  test("a concurrent direct writer fails closed before persisting a stale category", async () => {
    await ctx.db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, tenant_id);
      await expect(
        ctx.db
          .insert(connectors)
          .values({
            tenant_id,
            slug: "contended-category",
            display_name: "Contended",
            driver: "http",
            environment: "dev",
            auth_type: "none",
            base_url: "https://example.test",
            category: "purpose-race",
          })
          .execute(),
      ).rejects.toThrow();
    });
    const rows = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "contended-category")));
    expect(rows).toHaveLength(0);
  });

  test("another tenant cannot inherit category purpose or redirects", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: "isolated-categories", display_name: "Isolated" })
      .returning();
    if (!tenant) throw new Error("Tenant missing");
    await ctx.db.insert(connectors).values({
      tenant_id: tenant.id,
      slug: "isolated",
      display_name: "Isolated",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
      category: "target-swap",
    });
    const rows = await loadCategoryVocabulary(tenant.id, ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("target-swap");
    expect(rows[0]?.purpose).toBeNull();
    expect(rows[0]?.revision).toBe(1);
    expect(rows[0]?.aliases).toEqual([]);
  });
});

test("plain rename preserves generated purpose ownership without adopting it", async () => {
  await ctx.db.insert(catalogCategories).values({
    tenant_id,
    name: "generated-purpose",
    purpose: "Generated guidance",
    purpose_source: "llm",
  });
  await ctx.db.insert(connectors).values({
    tenant_id,
    slug: "generated-purpose",
    display_name: "Generated",
    driver: "http",
    environment: "dev",
    auth_type: "none",
    base_url: "https://example.test",
    category: "generated-purpose",
  });
  const result = await renameCategory(
    {
      tenant_id,
      from: "generated-purpose",
      to: "renamed-purpose",
      purpose: "Generated guidance",
      aliases: [],
      preserve_purpose: true,
      expected_source_revision: 1,
      expected_target_revision: null,
    },
    ctx.db,
  );
  expect(result.metadata.purpose).toBe("Generated guidance");
  expect(result.metadata.purpose_source).toBe("llm");
  expect(result.purpose_generation).toBe("not_requested");
});
