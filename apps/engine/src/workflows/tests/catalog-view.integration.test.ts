import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { UNCATEGORIZED } from "../../api/catalog-metadata.ts";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { lockCatalogVocabulary } from "../../db/catalog-vocabulary.ts";
import {
  auditLog,
  catalogCategories,
  connectors,
  knowledgeSources,
  tenants,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { serializeOne } from "../../http/routes/workflow-representation.ts";
import { provisionSelfServiceTenant } from "../../identity/self-service.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { describePendingCategoryPurposes } from "../catalog-describe.ts";
import { loadCategoryVocabulary, renameCategory } from "../catalog-view.ts";
import { listConnectorRefs, listWorkflowsUsingConnector } from "../connector-refs.ts";
import {
  createWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  updateWorkflowMetadata,
} from "../service.ts";

let ctx: TestDb;
let tenant_id = "";
let apiConnectorId = "";

async function seedConnector(slug: string): Promise<string> {
  const [row] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.example.test",
      config: {},
    })
    .returning();
  if (!row) throw new Error(`seed connector ${slug} failed`);
  return row.id;
}

async function seedWorkflow(
  slug: string,
  step: Record<string, unknown>,
  category?: string,
): Promise<string> {
  const result = await createWorkflow(
    {
      tenant_id,
      actor_id: null,
      def: { name: slug, slug, steps: [step] },
      ...(category ? { metadata: { category } } : {}),
    },
    ctx.db,
  );
  if (!result.workflow) throw new Error(`seed ${slug} failed: ${JSON.stringify(result.errors)}`);
  return result.workflow.id;
}

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

describe("stored categories over a live catalog", () => {
  test("a workflow keeps the category it was given, independent of its slug", async () => {
    const { rows } = await listWorkflows(tenant_id, {}, ctx.db);
    expect(rows.find((r) => r.slug === "notion-search-pages")?.category).toBe("notion");
    expect(rows.find((r) => r.slug === "berlin-weather-by-date")?.category).toBe(UNCATEGORIZED);
    expect(rows.find((r) => r.slug === "notion-search-pages")?.category_source).toBe("human");
    expect(rows.find((r) => r.slug === "berlin-weather-by-date")?.category_source).toBe("llm");
  });

  test("one workflow read on its own names the same block the list does", async () => {
    const { rows } = await listWorkflows(tenant_id, {}, ctx.db);
    for (const row of rows) {
      const workflow = await getWorkflow(tenant_id, row.id, ctx.db);
      if (!workflow) throw new Error(`missing ${row.slug}`);
      const detail = await serializeOne(workflow, tenant_id, ctx.db);
      expect(detail.category).toBe(row.category);
    }
  });

  test("filtering by category returns that block and totals only matches", async () => {
    const { rows, total } = await listWorkflows(tenant_id, { category: "notion" }, ctx.db);
    expect(total).toBe(3);
    expect(rows.map((r) => r.slug).sort()).toEqual([
      "notion-append-markdown",
      "notion-page-properties",
      "notion-search-pages",
    ]);
  });

  test("an unknown category matches nothing rather than everything", async () => {
    const { rows, total } = await listWorkflows(tenant_id, { category: "nope" }, ctx.db);
    expect(total).toBe(0);
    expect(rows).toHaveLength(0);
  });

  test("changing the category leaves the slug, and with it the wf_<slug> tool name, alone", async () => {
    const { rows } = await listWorkflows(tenant_id, { category: "notion" }, ctx.db);
    const target = rows.find((r) => r.slug === "notion-page-properties");
    if (!target) throw new Error("missing notion-page-properties");
    const result = await updateWorkflowMetadata(
      { tenant_id, id: target.id, category: "knowledge-pages", actor_id: null },
      ctx.db,
    );
    expect(result.workflow?.slug).toBe("notion-page-properties");
    expect(result.workflow?.category).toBe("knowledge-pages");
    await updateWorkflowMetadata(
      { tenant_id, id: target.id, category: "notion", actor_id: null },
      ctx.db,
    );
  });
});

describe("one vocabulary across every catalog kind", () => {
  test("counts each kind under the shared category, catch-all last", async () => {
    await ctx.db.insert(knowledgeSources).values({
      tenant_id,
      name: "Notion handbook",
      slug: "notion-handbook",
      category: "notion",
      source_type: "inline",
      source_uri: "inline:notion-handbook",
      version: "1",
    });
    const vocabulary = await loadCategoryVocabulary(tenant_id, ctx.db);
    const notion = vocabulary.find((v) => v.category === "notion");
    expect(notion?.counts.workflow).toBe(3);
    expect(notion?.counts.knowledge_source).toBe(1);
    expect(notion?.total).toBe(4);
    expect(vocabulary.at(-1)?.category).toBe(UNCATEGORIZED);
  });

  test("the reserved blocks can be neither renamed nor taken over", async () => {
    await expect(
      renameCategory(
        {
          purpose: "Catalog purpose",
          aliases: [],
          expected_source_revision: null,
          expected_target_revision: null,
          tenant_id,
          from: "other",
          to: "reports",
        },
        ctx.db,
      ),
    ).rejects.toThrow("Reserved");
    await expect(
      renameCategory(
        {
          purpose: "Catalog purpose",
          aliases: [],
          expected_source_revision: null,
          expected_target_revision: null,
          tenant_id,
          from: "platform",
          to: "reports",
        },
        ctx.db,
      ),
    ).rejects.toThrow("Reserved");
    await expect(
      renameCategory(
        {
          purpose: "Catalog purpose",
          aliases: [],
          expected_source_revision: null,
          expected_target_revision: null,
          tenant_id,
          from: "notion",
          to: "platform",
        },
        ctx.db,
      ),
    ).rejects.toThrow("Reserved");
  });

  test("renaming moves every kind at once and leaves one audit row", async () => {
    const result = await renameCategory(
      {
        tenant_id,
        from: "notion",
        to: "knowledge-pages",
        actor_type: "system",
        purpose: "Shared pages",
        aliases: ["Docs"],
        expected_source_revision: 1,
        expected_target_revision: 1,
      },
      ctx.db,
    );
    expect(result.moved.workflow).toBe(3);
    expect(result.moved.knowledge_source).toBe(1);
    expect(result.total).toBe(4);
    const { total } = await listWorkflows(tenant_id, { category: "notion" }, ctx.db);
    expect(total).toBe(0);
    await _drainAuditWritesForTests();
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "catalog_category.renamed")),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      from: "notion",
      to: "knowledge-pages",
      total: 4,
    });
    await renameCategory(
      {
        purpose: "Catalog purpose",
        aliases: [],
        expected_source_revision: result.metadata.revision,
        expected_target_revision: null,
        tenant_id,
        from: "knowledge-pages",
        to: "notion",
      },
      ctx.db,
    );
  });
});

describe("the workflow description has one owner", () => {
  test("a new version without a description keeps the one a person wrote", async () => {
    const id = await seedWorkflow("described-report", {
      id: "s1",
      kind: "request",
      method: "GET",
      url: "https://reports.example.test/x",
    });
    await updateWorkflowMetadata(
      {
        tenant_id,
        id,
        description: "Sends the weekly report.",
        actor_id: null,
      },
      ctx.db,
    );
    const updated = await updateWorkflow(
      {
        tenant_id,
        id,
        actor_id: null,
        def: {
          name: "described-report",
          slug: "described-report",
          steps: [
            {
              id: "s1",
              kind: "request",
              method: "GET",
              url: "https://reports.example.test/y",
            },
          ],
        },
      },
      ctx.db,
    );
    expect(updated.workflow?.current_version).toBe(2);
    expect(updated.workflow?.description).toBe("Sends the weekly report.");
    expect(updated.workflow?.description_source).toBe("human");
  });

  test("a description-only change updates the text without minting a version", async () => {
    const { rows } = await listWorkflows(tenant_id, { q: "described-report" }, ctx.db);
    const id = rows[0]?.id ?? "";
    const result = await updateWorkflow(
      {
        tenant_id,
        id,
        actor_id: null,
        def: {
          name: "described-report",
          slug: "described-report",
          description: "Sends the weekly report to finance.",
          steps: [
            {
              id: "s1",
              kind: "request",
              method: "GET",
              url: "https://reports.example.test/y",
            },
          ],
        },
      },
      ctx.db,
    );
    expect(result.workflow?.current_version).toBe(2);
    expect(result.workflow?.description).toBe("Sends the weekly report to finance.");
    expect(result.workflow?.definition.description).toBe("Sends the weekly report to finance.");
    const versions = await ctx.db
      .select({ dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, id));
    for (const v of versions)
      expect((v.dag as { description?: string }).description).toBeUndefined();
  });

  test("clearing the description hands it back to automatic description", async () => {
    const { rows } = await listWorkflows(tenant_id, { q: "described-report" }, ctx.db);
    const result = await updateWorkflowMetadata(
      { tenant_id, id: rows[0]?.id ?? "", description: "", actor_id: null },
      ctx.db,
    );
    expect(result.workflow?.description).toBeNull();
    expect(result.workflow?.description_source).toBe("llm");
  });
});

describe("connector references", () => {
  test("reports both binding forms as usage", async () => {
    const refs = await listConnectorRefs(tenant_id, ctx.db);
    const all = [...refs.values()].flat();
    expect(all.filter((s) => s === "billing-api")).toHaveLength(2);
    expect(all).not.toContain("unused-api");
  });

  test("filters workflows by connector across both binding forms", async () => {
    const { rows, total } = await listWorkflows(tenant_id, { connector: "billing-api" }, ctx.db);
    expect(total).toBe(2);
    expect(rows.map((r) => r.slug).sort()).toEqual(["billing-by-id", "billing-by-placeholder"]);
  });

  test("accepts the connector id as well as the slug", async () => {
    const { rows } = await listWorkflows(tenant_id, { connector: apiConnectorId }, ctx.db);
    expect(rows.map((r) => r.slug).sort()).toEqual(["billing-by-id", "billing-by-placeholder"]);
  });

  test("the delete guard sees the placeholder-only dependant", async () => {
    const deps = await listWorkflowsUsingConnector(tenant_id, apiConnectorId, ctx.db);
    expect(deps.map((d) => d.slug).sort()).toEqual(["billing-by-id", "billing-by-placeholder"]);
  });

  test("an unreferenced connector has no dependants", async () => {
    const { total } = await listWorkflows(tenant_id, { connector: "unused-api" }, ctx.db);
    expect(total).toBe(0);
  });

  test("an unknown connector matches nothing rather than everything", async () => {
    const { total } = await listWorkflows(tenant_id, { connector: "does-not-exist" }, ctx.db);
    expect(total).toBe(0);
  });

  test("category and connector compose", async () => {
    const { total } = await listWorkflows(
      tenant_id,
      { category: "notion", connector: "billing-api" },
      ctx.db,
    );
    expect(total).toBe(0);
  });
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

const describedAt = "2026-01-01T00:00:00.000Z";
const catalogMetadataWrite =
  "catalog_described_at = $2::timestamptz, catalog_input_hash = 'metadata-only'";

const catalogWriters = [
  {
    table: "connectors",
    key: "id",
    insert:
      "INSERT INTO subkit.connectors (tenant_id, slug, display_name, driver, environment, auth_type, base_url, config, category) VALUES ($1, $2, $2, 'http', 'dev', 'none', 'https://example.test', '{}', $3) RETURNING id::text AS key",
    metadata: catalogMetadataWrite,
  },
  {
    table: "workflows",
    key: "id",
    insert:
      "INSERT INTO subkit.workflows (tenant_id, slug, name, lifecycle, category) VALUES ($1, $2, $2, 'active', $3) RETURNING id::text AS key",
    metadata: catalogMetadataWrite,
  },
  {
    table: "skills",
    key: "id",
    insert:
      "INSERT INTO subkit.skills (tenant_id, slug, scope, title, body, lifecycle, category) VALUES ($1, $2, 'global', $2, 'Body', 'active', $3) RETURNING id::text AS key",
    metadata: catalogMetadataWrite,
  },
  {
    table: "knowledge_sources",
    key: "id",
    insert:
      "INSERT INTO subkit.knowledge_sources (tenant_id, name, slug, source_type, source_uri, version, category) VALUES ($1, $2, $2, 'text', 'inline:', '1', $3) RETURNING id::text AS key",
    metadata: catalogMetadataWrite,
  },
  {
    table: "files",
    key: "id",
    insert:
      "INSERT INTO subkit.files (tenant_id, filename, storage_uri, status, category) VALUES ($1, $2, 'local://' || $2, 'ready', $3) RETURNING id::text AS key",
    metadata: catalogMetadataWrite,
  },
  {
    table: "intake_category_defaults",
    key: "actor_id",
    insert:
      "INSERT INTO subkit.intake_category_defaults (tenant_id, actor_type, actor_id, category) VALUES ($1, 'user', md5($2)::uuid, $3) RETURNING actor_id::text AS key",
    metadata: "updated_at = $2::timestamptz",
  },
] as const;

type CatalogWriter = (typeof catalogWriters)[number];

async function insertCatalogRow(
  writer: CatalogWriter,
  slug: string,
  category: string,
  owner = tenant_id,
) {
  const result = await ctx.pool.query<{ key: string }>(writer.insert, [owner, slug, category]);
  const key = result.rows[0]?.key;
  if (!key) throw new Error(`seed ${writer.table} ${slug} failed`);
  return key;
}

function metadataUpdate(writer: CatalogWriter) {
  return `UPDATE subkit.${writer.table} SET ${writer.metadata} WHERE tenant_id = $1 AND ${writer.key}::text = $3`;
}

async function categoryOf(writer: CatalogWriter, key: string, owner = tenant_id) {
  const result = await ctx.pool.query<{ category: string }>(
    `SELECT category FROM subkit.${writer.table} WHERE tenant_id = $1 AND ${writer.key}::text = $2`,
    [owner, key],
  );
  return result.rows[0]?.category;
}

async function waitForLockWait(operation: { done: boolean }) {
  await waitFor(
    async () => {
      if (operation.done) return true;
      const result = await ctx.pool.query<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      return (result.rows[0]?.waiting ?? 0) > 0;
    },
    { label: "writer waits on the row lock", sleepMs: 5, tries: 1000 },
  );
}

function settled(operation: Promise<unknown>) {
  const tracked = { done: false, result: Promise.resolve<unknown>(null) };
  tracked.result = operation
    .then(
      () => null,
      (error: unknown) => error,
    )
    .finally(() => {
      tracked.done = true;
    });
  return tracked;
}

describe("catalog vocabulary lock scope", () => {
  for (const writer of catalogWriters) {
    const slug = writer.table.replace(/_/g, "-");

    test(`a metadata-only ${writer.table} update succeeds while the vocabulary is locked`, async () => {
      const key = await insertCatalogRow(writer, `lock-scope-${slug}`, "lock-scope");
      await ctx.db.transaction(async (tx) => {
        await lockCatalogVocabulary(tx, tenant_id);
        const metadataOnly = await ctx.pool.query(metadataUpdate(writer), [
          tenant_id,
          describedAt,
          key,
        ]);
        expect(metadataOnly.rowCount).toBe(1);
        const sameCategory = await ctx.pool.query(
          `UPDATE subkit.${writer.table} SET category = category WHERE tenant_id = $1 AND ${writer.key}::text = $2`,
          [tenant_id, key],
        );
        expect(sameCategory.rowCount).toBe(1);
      });
      expect(await categoryOf(writer, key)).toBe("lock-scope");
    });

    test(`a ${writer.table} category change still fails closed while the vocabulary is locked`, async () => {
      const key = await insertCatalogRow(writer, `lock-change-${slug}`, "lock-scope");
      await ctx.db.transaction(async (tx) => {
        await lockCatalogVocabulary(tx, tenant_id);
        await expect(
          ctx.pool.query(
            `UPDATE subkit.${writer.table} SET category = 'lock-elsewhere' WHERE tenant_id = $1 AND ${writer.key}::text = $2`,
            [tenant_id, key],
          ),
        ).rejects.toMatchObject({ code: "40001" });
      });
      expect(await categoryOf(writer, key)).toBe("lock-scope");
    });
  }

  test("a platform skill insert still fails closed while the vocabulary is locked", async () => {
    await ctx.db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, tenant_id);
      await expect(
        ctx.pool.query(
          "INSERT INTO subkit.skills (tenant_id, slug, scope, title, body, lifecycle, category) VALUES ($1, 'locked-platform', 'global', 'Locked', 'Body', 'active', 'platform')",
          [tenant_id],
        ),
      ).rejects.toMatchObject({ code: "40001" });
    });
  });

  test("moving a row to another tenant still takes that tenant's vocabulary lock", async () => {
    const [other] = await ctx.db
      .insert(tenants)
      .values({ slug: "lock-scope-destination", display_name: "Destination" })
      .returning();
    if (!other) throw new Error("Tenant missing");
    const writer = catalogWriters[0];
    const key = await insertCatalogRow(writer, "lock-tenant-move", "lock-scope");
    await ctx.db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, other.id);
      await expect(
        ctx.pool.query(
          "UPDATE subkit.connectors SET tenant_id = $2 WHERE tenant_id = $1 AND id::text = $3",
          [tenant_id, other.id, key],
        ),
      ).rejects.toMatchObject({ code: "40001" });
    });
    expect(await categoryOf(writer, key)).toBe("lock-scope");
  });

  test("a rename waits for an open metadata writer and then moves its row", async () => {
    const writer = catalogWriters[0];
    const key = await insertCatalogRow(writer, "race-writer-first", "race-a");
    const metadataWriter = await ctx.pool.connect();
    try {
      await metadataWriter.query("BEGIN");
      await metadataWriter.query(metadataUpdate(writer), [tenant_id, describedAt, key]);
      const rename = settled(
        renameCategory(
          {
            tenant_id,
            from: "race-a",
            to: "race-b",
            purpose: "Race purpose",
            aliases: [],
            expected_source_revision: 1,
            expected_target_revision: null,
          },
          ctx.db,
        ),
      );
      await waitForLockWait(rename);
      await metadataWriter.query("COMMIT");
      expect(await rename.result).toBeNull();
    } finally {
      await metadataWriter.query("ROLLBACK");
      metadataWriter.release();
    }
    const [row] = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, key)));
    expect(row?.category).toBe("race-b");
    expect(row?.catalog_input_hash).toBe("metadata-only");
    const [redirect] = await ctx.db
      .select()
      .from(catalogCategories)
      .where(and(eq(catalogCategories.tenant_id, tenant_id), eq(catalogCategories.name, "race-a")));
    expect(redirect?.redirect_to).toBe("race-b");
  });

  test("a metadata writer behind an open rename keeps the renamed category", async () => {
    const writer = catalogWriters[0];
    const key = await insertCatalogRow(writer, "race-rename-first", "race-c");
    const renamer = await ctx.pool.connect();
    try {
      await renamer.query("BEGIN");
      await renamer.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 741937))", [
        tenant_id,
      ]);
      await renamer.query(
        "UPDATE subkit.connectors SET category = 'race-d' WHERE tenant_id = $1 AND category = 'race-c'",
        [tenant_id],
      );
      await renamer.query(
        "UPDATE subkit.catalog_categories SET redirect_to = 'race-d' WHERE tenant_id = $1 AND name = 'race-c'",
        [tenant_id],
      );
      const metadataOnly = settled(
        ctx.pool.query(metadataUpdate(writer), [tenant_id, describedAt, key]),
      );
      await waitForLockWait(metadataOnly);
      await renamer.query("COMMIT");
      expect(await metadataOnly.result).toBeNull();
    } finally {
      await renamer.query("ROLLBACK");
      renamer.release();
    }
    expect(await categoryOf(writer, key)).toBe("race-d");
    await ctx.pool.query(
      "UPDATE subkit.connectors SET category = 'race-c' WHERE tenant_id = $1 AND id::text = $2",
      [tenant_id, key],
    );
    expect(await categoryOf(writer, key)).toBe("race-d");
  });
});

describe("catalog vocabulary lock scope on hosted tenants", () => {
  let hosted_tenant_id = "";

  beforeAll(async () => {
    await configureHostedPolicyForTests(ctx.db, ctx.url);
    const hosted = await provisionSelfServiceTenant(
      {
        issuer_url: "https://identity.example.test",
        subject: "lock-scope-hosted",
        email: "lock-scope-hosted@example.test",
        email_verified: true,
      },
      ctx.db,
    );
    hosted_tenant_id = hosted.tenant.id;
  });

  for (const writer of catalogWriters) {
    const slug = writer.table.replace(/_/g, "-");

    test(`a byte-neutral ${writer.table} update succeeds while the hosted vocabulary is locked`, async () => {
      const key = await insertCatalogRow(
        writer,
        `hosted-neutral-${slug}`,
        "lock-scope",
        hosted_tenant_id,
      );
      await ctx.db.transaction(async (tx) => {
        await lockCatalogVocabulary(tx, hosted_tenant_id);
        const sameCategory = await ctx.pool.query(
          `UPDATE subkit.${writer.table} SET category = category WHERE tenant_id = $1 AND ${writer.key}::text = $2`,
          [hosted_tenant_id, key],
        );
        expect(sameCategory.rowCount).toBe(1);
      });
      expect(await categoryOf(writer, key, hosted_tenant_id)).toBe("lock-scope");
    });

    if (writer.metadata !== catalogMetadataWrite) continue;

    test(`a metered ${writer.table} metadata update fails closed through the hosted quota while the vocabulary is locked`, async () => {
      const key = await insertCatalogRow(
        writer,
        `hosted-metered-${slug}`,
        "lock-scope",
        hosted_tenant_id,
      );
      await ctx.db.transaction(async (tx) => {
        await lockCatalogVocabulary(tx, hosted_tenant_id);
        await expect(
          ctx.pool.query(metadataUpdate(writer), [hosted_tenant_id, describedAt, key]),
        ).rejects.toMatchObject({
          code: "40001",
          message: "hosted_quota_concurrent_write",
        });
      });
      expect(await categoryOf(writer, key, hosted_tenant_id)).toBe("lock-scope");
    });
  }
});
