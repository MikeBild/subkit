// Pins that workflow_versions.scope_index round-trips when supplied
// to createWorkflow / updateWorkflow. The conversation commit path
// reads `latest_preview.step_traces` and threads the scope map
// through these service functions; this test ensures the column is
// actually written end-to-end.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { tenants, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createWorkflow, updateWorkflow } from "../service.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("scope_index_persistence");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-si", display_name: "T-SI" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

const sampleDef = {
  name: "scope-index-test",
  slug: "scope-index-test",
  steps: [
    { id: "fetch", kind: "request", method: "GET", url: "https://example.com/items" },
    {
      id: "shape",
      kind: "transform",
      language: "javascript",
      expression: "return input.scope.fetch.data;",
    },
  ],
};

const sampleScope = {
  fetch: {
    available_paths: ["data", "data.items", "data.items[*]"],
    shape_summary: "object{data}",
    primary_data_path: "data.items" as string | null,
  },
  shape: {
    available_paths: [],
    shape_summary: "object{}",
    primary_data_path: null as string | null,
  },
};

describe("workflow_versions.scope_index", () => {
  test("createWorkflow persists scope_index when provided", async () => {
    const result = await createWorkflow(
      { tenant_id, def: sampleDef, actor_id: null, scope_index: sampleScope },
      ctx.db,
    );
    if ("errors" in result) throw new Error(`unexpected: ${result.errors.join("; ")}`);
    const wf = result.workflow;
    const rows = await ctx.db
      .select()
      .from(workflowVersions)
      .where(
        and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.workflow_id, wf.id)),
      )
      .limit(1);
    const row = rows[0];
    expect(row?.scope_index).toEqual(sampleScope);
  });

  test("updateWorkflow refreshes scope_index in place when the def is unchanged", async () => {
    // scope_index is per-step authoring metadata, not workflow
    // behaviour. When the def is unchanged, updateWorkflow must NOT
    // rotate the version (that churns history and unbinds schedules) —
    // it writes the fresher scope_index onto the current version row.
    const created = await createWorkflow(
      {
        tenant_id,
        def: { ...sampleDef, slug: "scope-index-update", name: "scope-index-update" },
        actor_id: null,
        scope_index: sampleScope,
      },
      ctx.db,
    );
    if ("errors" in created) throw new Error(`unexpected: ${created.errors.join("; ")}`);
    const updatedScope = {
      fetch: {
        available_paths: ["data", "data.results"],
        shape_summary: "object{data}",
        primary_data_path: "data.results" as string | null,
      },
    };
    const updated = await updateWorkflow(
      {
        tenant_id,
        id: created.workflow.id,
        def: { ...sampleDef, slug: "scope-index-update", name: "scope-index-update" },
        actor_id: null,
        scope_index: updatedScope,
      },
      ctx.db,
    );
    if ("errors" in updated) throw new Error(`unexpected: ${updated.errors.join("; ")}`);
    const rows = await ctx.db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, updated.workflow.id))
      .orderBy(workflowVersions.version);
    // Still one version — the unchanged def was not re-rotated.
    expect(rows.length).toBe(1);
    // …but the scope_index on it was refreshed in place.
    expect(rows[0]?.scope_index).toEqual(updatedScope);
    expect(updated.workflow.current_version).toBe(1);
  });

  test("updateWorkflow rotates the version when the def actually changes", async () => {
    const created = await createWorkflow(
      {
        tenant_id,
        def: { ...sampleDef, slug: "scope-index-rotate", name: "scope-index-rotate" },
        actor_id: null,
        scope_index: sampleScope,
      },
      ctx.db,
    );
    if ("errors" in created) throw new Error(`unexpected: ${created.errors.join("; ")}`);
    const updated = await updateWorkflow(
      {
        tenant_id,
        id: created.workflow.id,
        def: {
          ...sampleDef,
          slug: "scope-index-rotate",
          // A changed step expression is a real def change → new version.
          name: "scope-index-rotate",
          steps: [
            { id: "fetch", kind: "request", method: "GET", url: "https://example.com/items" },
            {
              id: "shape",
              kind: "transform",
              language: "javascript",
              expression: "return input.scope.fetch.data.items;",
            },
          ],
        },
        actor_id: null,
        scope_index: sampleScope,
      },
      ctx.db,
    );
    if ("errors" in updated) throw new Error(`unexpected: ${updated.errors.join("; ")}`);
    const rows = await ctx.db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, updated.workflow.id))
      .orderBy(workflowVersions.version);
    expect(rows.length).toBe(2);
  });

  test("createWorkflow without scope_index leaves the column null", async () => {
    const result = await createWorkflow(
      {
        tenant_id,
        def: { ...sampleDef, slug: "scope-index-null", name: "scope-index-null" },
        actor_id: null,
      },
      ctx.db,
    );
    if ("errors" in result) throw new Error(`unexpected: ${result.errors.join("; ")}`);
    const rows = await ctx.db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, result.workflow.id));
    expect(rows[0]?.scope_index).toBeNull();
  });
});
