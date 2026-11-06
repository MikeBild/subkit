import { workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { type WorkflowDef, WorkflowDefSchema } from "../../workflows/types.ts";

export {
  createMockServer,
  type Handler,
  jsonResponse,
  type MockServer,
} from "../../test-helpers/mock-http.ts";

export interface EngineTestCtx {
  testDb: TestDb;
  tenantId: string;
  cleanup: () => Promise<void>;
}

export async function createEngineCtx(label: string): Promise<EngineTestCtx> {
  const testDb = await createTestDb(`engine-${label}`);
  const tenant = await seedTenant(testDb.db, {
    slug: `et-${label}`,
    display_name: `Engine ${label}`,
  });
  return {
    testDb,
    tenantId: tenant.id,
    cleanup: async () => {
      await testDb.cleanup();
    },
  };
}

export async function createWorkflowRow(
  ctx: EngineTestCtx,
  rawDef: unknown,
): Promise<{ workflow_id: string; version_id: string }> {
  const def: WorkflowDef = WorkflowDefSchema.parse(rawDef);
  const [wf] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenantId,
      slug: def.slug ?? `wf-${Math.random().toString(36).slice(2, 8)}`,
      name: def.name,
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("workflow insert failed");
  const [v] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: def,
    })
    .returning();
  if (!v) throw new Error("workflow_versions insert failed");
  const { eq } = await import("drizzle-orm");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: v.id })
    .where(eq(workflows.id, wf.id));
  return { workflow_id: wf.id, version_id: v.id };
}
