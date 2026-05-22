// Engine test scaffolding.
//
// Each test that needs the engine builds:
//   - a disposable Postgres database (P1 helper)
//   - a tenant + workflow row referencing a hand-crafted dag
//   - optionally, a local mock HTTP server on a random port
//
// The mock HTTP server (`createMockServer` / `jsonResponse`) now lives in
// the shared `test-helpers/mock-http.ts` so the journey layer can import
// it too — re-exported here so existing `execution/` call sites keep
// working unchanged.

import { tenants, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
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
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `et-${label}`, display_name: `Engine ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
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
  // Parse to fill in defaults so the engine sees the canonical shape.
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
