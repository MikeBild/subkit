import { tenants, workflows } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";

export interface KnowledgeTestCtx {
  testDb: TestDb;
  tenantId: string;
  workflowId: string;
  cleanup: () => Promise<void>;
}

export async function createKnowledgeTestCtx(label: string): Promise<KnowledgeTestCtx> {
  const testDb = await createTestDb(`knowledge-${label}`);
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `t-${label}`, display_name: `Knowledge ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");

  const [workflow] = await testDb.db
    .insert(workflows)
    .values({
      tenant_id: tenant.id,
      slug: `wf-${label}`,
      name: `Test Workflow ${label}`,
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("seed workflow failed");

  return {
    testDb,
    tenantId: tenant.id,
    workflowId: workflow.id,
    cleanup: testDb.cleanup,
  };
}
