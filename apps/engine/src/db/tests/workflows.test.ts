import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";

import { tenants, workflows, workflowVersions } from "../schema/index.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("workflows");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("workflows + versions", () => {
  test("create workflow, snapshot versions, restore old version", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: "wf-co", display_name: "WF Co" })
      .returning();

    const [wf] = await ctx.db
      .insert(workflows)
      .values({
        tenant_id: tenant!.id,
        slug: "my-flow",
        name: "My Flow",
        lifecycle: "draft",
      })
      .returning();

    const dagV1 = { steps: [{ key: "a", kind: "request" }] };
    const dagV2 = {
      steps: [
        { key: "a", kind: "request" },
        { key: "b", kind: "transform" },
      ],
    };

    const [v1] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenant!.id,
        workflow_id: wf!.id,
        version: 1,
        dag: dagV1,
      })
      .returning();

    const [v2] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenant!.id,
        workflow_id: wf!.id,
        version: 2,
        dag: dagV2,
      })
      .returning();

    // point current version at v2
    await ctx.db
      .update(workflows)
      .set({ current_version_id: v2!.id, lifecycle: "active" })
      .where(eq(workflows.id, wf!.id));

    // restore by writing a v3 row that duplicates v1's dag (the "restore"
    // operation is always an additive new version, never a rewrite)
    const [v3] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenant!.id,
        workflow_id: wf!.id,
        version: 3,
        dag: v1!.dag,
        note: "restored from v1",
      })
      .returning();

    await ctx.db
      .update(workflows)
      .set({ current_version_id: v3!.id })
      .where(eq(workflows.id, wf!.id));

    // verify
    const latest = await ctx.db
      .select()
      .from(workflowVersions)
      .where(
        and(eq(workflowVersions.tenant_id, tenant!.id), eq(workflowVersions.workflow_id, wf!.id)),
      )
      .orderBy(desc(workflowVersions.version));

    expect(latest).toHaveLength(3);
    expect(latest[0]?.version).toBe(3);
    expect(latest[0]?.note).toBe("restored from v1");
    expect(latest[0]?.dag).toEqual(dagV1);

    const [current] = await ctx.db.select().from(workflows).where(eq(workflows.id, wf!.id));
    expect(current?.current_version_id).toBe(v3!.id);
    expect(current?.lifecycle).toBe("active");
  });
});
