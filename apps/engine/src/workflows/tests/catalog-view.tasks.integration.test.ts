import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { UNCATEGORIZED } from "../../api/catalog-metadata.ts";
import { tasks, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  describeOne,
  describePendingCatalog,
  hasPendingCatalogDescriptions,
} from "../catalog-describe.ts";
import {
  categoryRenameAffectsTasks,
  loadCategoryVocabulary,
  renameCategory,
} from "../catalog-view.ts";

let ctx: TestDb;
let tenant_id = "";
let other_tenant_id = "";

const OWNER = "33333333-3333-4333-8333-333333333333";
const COLLEAGUE = "33333333-3333-4333-8333-444444444444";

async function seedTask(
  tenant: string,
  name: string,
  category: string,
  lifecycle: "active" | "archived",
  owner_id = OWNER,
  source: "human" | "llm" = "human",
): Promise<string> {
  const [row] = await ctx.db
    .insert(tasks)
    .values({
      locale: "de",
      tenant_id: tenant,
      name,
      category,
      category_source: source,
      description_source: source,
      owner_id,
      goal: "Send the weekly report",
      done_when: "The report is in the inbox",
      plan: { title: "Report", goal: "Send the weekly report", steps: [] },
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: "a".repeat(64),
      lifecycle,
    })
    .returning({ id: tasks.id });
  if (!row) throw new Error("task fixture missing");
  return row.id;
}

async function categoryOf(tenant: string, id: string) {
  const [row] = await ctx.db
    .select({
      category: tasks.category,
      category_source: tasks.category_source,
      fingerprint: tasks.fingerprint,
      revision: tasks.revision,
    })
    .from(tasks)
    .where(and(eq(tasks.tenant_id, tenant), eq(tasks.id, id)));
  return row ?? null;
}

const rename = (tenant: string, from: string, to: string) =>
  renameCategory(
    {
      tenant_id: tenant,
      from,
      to,
      purpose: null,
      aliases: [],
      expected_source_revision: null,
      expected_target_revision: null,
    },
    ctx.db,
  );

beforeAll(async () => {
  ctx = await createTestDb("workflows_catalog_view_tasks");
  const [mine, other] = await ctx.db
    .insert(tenants)
    .values([
      { slug: "t-catalog-tasks", display_name: "Catalog tasks" },
      { slug: "t-catalog-tasks-other", display_name: "Catalog tasks other" },
    ])
    .returning();
  if (!mine || !other) throw new Error("tenant fixture missing");
  tenant_id = mine.id;
  other_tenant_id = other.id;
  await seedTask(tenant_id, "Weekly report", "reports", "active");
  await seedTask(tenant_id, "Monthly report", "reports", "active");
  await seedTask(tenant_id, "Retired report", "reports", "archived");
  await seedTask(tenant_id, "Retired cleanup", "housekeeping", "archived");
  await seedTask(other_tenant_id, "Foreign report", "reports", "active");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("category vocabulary counts for tasks", () => {
  test("archived tasks are not counted", async () => {
    const vocabulary = await loadCategoryVocabulary(tenant_id, ctx.db);
    const reports = vocabulary.find((entry) => entry.category === "reports");
    expect(reports?.counts.task).toBe(2);
    expect(reports?.total).toBe(2);
  });

  test("a category that holds only archived tasks does not appear", async () => {
    const vocabulary = await loadCategoryVocabulary(tenant_id, ctx.db);
    expect(vocabulary.map((entry) => entry.category)).not.toContain("housekeeping");
  });

  test("another tenant's tasks stay out of the count", async () => {
    const vocabulary = await loadCategoryVocabulary(other_tenant_id, ctx.db);
    expect(vocabulary.find((entry) => entry.category === "reports")?.counts.task).toBe(1);
  });
});

describe("category counts follow task visibility", () => {
  test("a person who is not an admin counts own tasks only; an admin counts all", async () => {
    await seedTask(tenant_id, "Colleague's audit", "audits", "active", COLLEAGUE);
    await seedTask(tenant_id, "Colleague's second audit", "audits", "active", COLLEAGUE);
    await seedTask(tenant_id, "Own audit", "audits", "active");
    await seedTask(tenant_id, "Colleague's secret", "private-block", "active", COLLEAGUE);
    const count = async (viewer?: { task_owner_id: string | null }) =>
      (await loadCategoryVocabulary(tenant_id, ctx.db, viewer)).find(
        (entry) => entry.category === "audits",
      )?.counts.task;
    expect(await count({ task_owner_id: OWNER })).toBe(1);
    expect(await count({ task_owner_id: COLLEAGUE })).toBe(2);
    expect(await count({ task_owner_id: null })).toBe(3);
    expect(await count()).toBe(3);
    const mine = await loadCategoryVocabulary(tenant_id, ctx.db, { task_owner_id: OWNER });
    expect(mine.map((entry) => entry.category)).not.toContain("private-block");
    expect(mine.find((entry) => entry.category === "audits")?.total).toBe(1);
  });
});

describe("renaming and merging a category moves tasks", () => {
  test("a rename moves every task of the block, archived ones too, and leaves other tenants alone", async () => {
    const active = await seedTask(tenant_id, "Close the books", "closing", "active");
    const archived = await seedTask(tenant_id, "Old closing", "closing", "archived", COLLEAGUE);
    const foreign = await seedTask(other_tenant_id, "Foreign closing", "closing", "active");
    expect(await categoryRenameAffectsTasks({ tenant_id, from: "closing" }, ctx.db)).toBe(true);
    expect(await categoryRenameAffectsTasks({ tenant_id, from: "no-such-block" }, ctx.db)).toBe(
      false,
    );
    const result = await rename(tenant_id, "closing", "month-end");
    expect(result.moved.task).toBe(2);
    expect((await categoryOf(tenant_id, active))?.category).toBe("month-end");
    expect((await categoryOf(tenant_id, archived))?.category).toBe("month-end");
    expect((await categoryOf(other_tenant_id, foreign))?.category).toBe("closing");
    expect(await categoryRenameAffectsTasks({ tenant_id, from: "closing" }, ctx.db)).toBe(false);
  });

  test("a merge adds the tasks to the target block's count", async () => {
    await seedTask(tenant_id, "Payroll check", "payroll", "active");
    await seedTask(tenant_id, "Salary run", "salaries", "active");
    const result = await rename(tenant_id, "salaries", "payroll");
    expect(result.moved.task).toBe(1);
    const vocabulary = await loadCategoryVocabulary(tenant_id, ctx.db);
    expect(vocabulary.find((entry) => entry.category === "payroll")?.counts.task).toBe(2);
    expect(vocabulary.map((entry) => entry.category)).not.toContain("salaries");
  });

  test("moving a task between blocks does not touch what a standing permission is bound to", async () => {
    const id = await seedTask(tenant_id, "Vendor review", "vendors", "active");
    const before = await categoryOf(tenant_id, id);
    await rename(tenant_id, "vendors", "suppliers");
    const after = await categoryOf(tenant_id, id);
    expect(before).not.toBeNull();
    expect(after).toEqual({
      category: "suppliers",
      category_source: "human",
      fingerprint: before?.fingerprint ?? "",
      revision: before?.revision ?? 0,
    });
  });
});

describe("the auto-describer and tasks", () => {
  test("a task is never selected, also when its catalog fields are not human-written", async () => {
    const id = await seedTask(
      other_tenant_id,
      "Machine-labelled",
      "labels",
      "active",
      OWNER,
      "llm",
    );
    expect(await hasPendingCatalogDescriptions(other_tenant_id, ctx.db)).toBe(false);
    expect(await describeOne({ tenant_id: other_tenant_id, kind: "task", id }, ctx.db)).toBe(
      "skipped",
    );
    expect(await describePendingCatalog(other_tenant_id, ctx.db)).toEqual({
      described: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      remaining: false,
    });
    expect((await categoryOf(other_tenant_id, id))?.category).toBe("labels");
  });

  test("a task moved to the uncategorized block is still not picked up", async () => {
    const id = await seedTask(other_tenant_id, "Loose end", "loose", "active");
    await rename(other_tenant_id, "loose", UNCATEGORIZED);
    expect(await categoryOf(other_tenant_id, id)).toMatchObject({
      category: UNCATEGORIZED,
      category_source: "llm",
    });
    expect(await describeOne({ tenant_id: other_tenant_id, kind: "task", id }, ctx.db)).toBe(
      "skipped",
    );
    expect((await categoryOf(other_tenant_id, id))?.category).toBe(UNCATEGORIZED);
  });
});
