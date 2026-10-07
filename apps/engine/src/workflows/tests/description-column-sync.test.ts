import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createWorkflow, getWorkflow, updateWorkflow } from "../service.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("description_column_sync");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-desc", display_name: "T-DESC" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

const DESC = "Publishes a Notion essay page to GitHub as Markdown with YAML frontmatter.";

function defWith(slug: string, description?: string) {
  return {
    name: slug,
    slug,
    ...(description !== undefined ? { description } : {}),
    steps: [
      { id: "compute", kind: "transform", language: "javascript", expression: "return input;" },
    ],
  };
}

describe("the workflow description column owns the text a definition brings", () => {
  test("createWorkflow seeds the column from def.description", async () => {
    const res = await createWorkflow(
      { tenant_id, def: defWith("desc-create", DESC), actor_id: null },
      ctx.db,
    );
    expect("workflow" in res).toBe(true);
    const id = (res as { workflow: { id: string } }).workflow.id;
    const view = await getWorkflow(tenant_id, id, ctx.db);
    expect(view?.description).toBe(DESC);
  });

  test("createWorkflow leaves the column NULL when the def carries no description", async () => {
    const res = await createWorkflow(
      { tenant_id, def: defWith("desc-none"), actor_id: null },
      ctx.db,
    );
    const id = (res as { workflow: { id: string } }).workflow.id;
    const view = await getWorkflow(tenant_id, id, ctx.db);
    expect(view?.description ?? null).toBeNull();
  });

  test("updateWorkflow syncs the column when the def's description changes", async () => {
    const created = await createWorkflow(
      { tenant_id, def: defWith("desc-update"), actor_id: null },
      ctx.db,
    );
    const id = (created as { workflow: { id: string } }).workflow.id;
    expect((await getWorkflow(tenant_id, id, ctx.db))?.description ?? null).toBeNull();

    const updated = await updateWorkflow(
      { tenant_id, id, def: defWith("desc-update", DESC), actor_id: null },
      ctx.db,
    );
    expect("workflow" in updated).toBe(true);
    expect((await getWorkflow(tenant_id, id, ctx.db))?.description).toBe(DESC);
  });

  test("updateWorkflow keeps the column when the def carries no description", async () => {
    const created = await createWorkflow(
      { tenant_id, def: defWith("desc-keep", DESC), actor_id: null },
      ctx.db,
    );
    const id = (created as { workflow: { id: string } }).workflow.id;
    expect((await getWorkflow(tenant_id, id, ctx.db))?.description).toBe(DESC);

    await updateWorkflow({ tenant_id, id, def: defWith("desc-keep"), actor_id: null }, ctx.db);
    const view = await getWorkflow(tenant_id, id, ctx.db);
    expect(view?.description).toBe(DESC);
    expect(view?.description_source).toBe("human");
    expect(view?.definition.description).toBe(DESC);
  });
});
