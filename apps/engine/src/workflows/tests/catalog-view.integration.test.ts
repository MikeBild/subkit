import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { UNCATEGORIZED } from "../../api/catalog-metadata.ts";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import {
  auditLog,
  connectors,
  knowledgeSources,
  tenants,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { serializeOne } from "../../http/routes/workflow-representation.ts";
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
      { id: "s1", kind: "request", method: "GET", url: "https://notion.example.test/x" },
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
      renameCategory({ tenant_id, from: "other", to: "reports" }, ctx.db),
    ).rejects.toThrow("cannot be renamed");
    await expect(
      renameCategory({ tenant_id, from: "platform", to: "reports" }, ctx.db),
    ).rejects.toThrow("cannot be renamed");
    await expect(
      renameCategory({ tenant_id, from: "notion", to: "platform" }, ctx.db),
    ).rejects.toThrow("reserved");
  });

  test("renaming moves every kind at once and leaves one audit row", async () => {
    const result = await renameCategory(
      { tenant_id, from: "notion", to: "knowledge-pages", actor_type: "system" },
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
    expect(rows[0]?.metadata).toMatchObject({ from: "notion", to: "knowledge-pages", total: 4 });
    await renameCategory({ tenant_id, from: "knowledge-pages", to: "notion" }, ctx.db);
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
      { tenant_id, id, description: "Sends the weekly report.", actor_id: null },
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
            { id: "s1", kind: "request", method: "GET", url: "https://reports.example.test/y" },
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
            { id: "s1", kind: "request", method: "GET", url: "https://reports.example.test/y" },
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
