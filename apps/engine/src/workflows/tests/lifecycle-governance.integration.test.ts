import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, workflows } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant, seedWorkflow } from "../../test-helpers/seed.ts";
import { saveWorkflowDraft } from "../drafts.ts";
import { updateWorkflowMetadata } from "../service.ts";

let ctx: TestDb;
let tenant_id: string;

const definition = (slug: string) => ({
  name: slug,
  slug,
  steps: [{ id: "compute", kind: "transform", language: "javascript", expression: "return 1;" }],
});

async function lifecycleOf(id: string) {
  const [row] = await ctx.db
    .select({ lifecycle: workflows.lifecycle })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id)));
  return row?.lifecycle;
}

beforeAll(async () => {
  ctx = await createTestDb("lifecycle_governance");
  tenant_id = (await seedTenant(ctx.db)).id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("updateWorkflowMetadata owns no path from draft to active", () => {
  test("a draft workflow is not activated through metadata", async () => {
    const saved = await saveWorkflowDraft(
      { tenant_id, def: definition("governed-draft"), actor_id: null, request_source: "api" },
      ctx.db,
    );
    const workflow_id = saved.draft?.workflow_id;
    if (!workflow_id) throw new Error(saved.errors?.join("; "));
    expect(await lifecycleOf(workflow_id)).toBe("draft");

    const result = await updateWorkflowMetadata(
      { tenant_id, id: workflow_id, lifecycle: "active", actor_id: null },
      ctx.db,
    );
    expect(result.workflow).toBeUndefined();
    expect((result as { code?: string }).code).toBe("lifecycle_transition_not_allowed");
    expect(result.errors?.[0]).toBe(
      "a draft workflow becomes active only through review and activation",
    );
    expect(await lifecycleOf(workflow_id)).toBe("draft");
    const audits = await ctx.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.resource_id, workflow_id),
          eq(auditLog.action, "workflow.updated"),
        ),
      );
    expect(audits).toHaveLength(0);
  });

  test("a draft workflow can still be archived", async () => {
    const saved = await saveWorkflowDraft(
      { tenant_id, def: definition("archived-draft"), actor_id: null, request_source: "api" },
      ctx.db,
    );
    const workflow_id = saved.draft?.workflow_id;
    if (!workflow_id) throw new Error(saved.errors?.join("; "));
    const archived = await updateWorkflowMetadata(
      { tenant_id, id: workflow_id, lifecycle: "archived", actor_id: null },
      ctx.db,
    );
    expect(archived.workflow?.lifecycle).toBe("archived");

    const restored = await updateWorkflowMetadata(
      { tenant_id, id: workflow_id, lifecycle: "active", actor_id: null },
      ctx.db,
    );
    expect((restored as { code?: string }).code).toBe("no_current_version");
    expect(await lifecycleOf(workflow_id)).toBe("archived");
  });

  test("an active workflow is archived and restored", async () => {
    const { workflow } = await seedWorkflow(ctx.db, {
      tenant_id,
      def: definition("round-trip") as never,
    });
    const archived = await updateWorkflowMetadata(
      { tenant_id, id: workflow.id, lifecycle: "archived", actor_id: null },
      ctx.db,
    );
    expect(archived.workflow?.lifecycle).toBe("archived");
    const restored = await updateWorkflowMetadata(
      { tenant_id, id: workflow.id, lifecycle: "active", actor_id: null },
      ctx.db,
    );
    expect(restored.workflow?.lifecycle).toBe("active");
    const unchanged = await updateWorkflowMetadata(
      { tenant_id, id: workflow.id, lifecycle: "active", actor_id: null },
      ctx.db,
    );
    expect(unchanged.workflow?.lifecycle).toBe("active");
  });
});
