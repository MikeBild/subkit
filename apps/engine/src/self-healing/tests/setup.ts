import {
  connectors,
  executionFixtures,
  executionSteps,
  executions,
  schemaVersions,
  tenants,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";

export interface SelfHealingTestCtx {
  testDb: TestDb;
  label: string;
  tenant_id: string;
  connector_id: string;
  workflow_id: string;
  workflow_version_id: string;
  execution_id: string;
  step_id: string;
  fixture_id: string;
  endpoint_key: string;
  cleanup: () => Promise<void>;
}

export const SEED_STEP_ID = "req-1";

export const SEED_DATA_SELECTOR = "$.data.id";

function buildSeedDag(label: string, connector_id: string) {
  return {
    name: `Workflow ${label}`,
    steps: [
      {
        kind: "request",
        id: SEED_STEP_ID,
        method: "GET",
        connector_id,
        path: "/users/1",
        data_selector: SEED_DATA_SELECTOR,
      },
    ],
  };
}

export async function resetSeedDag(ctx: SelfHealingTestCtx): Promise<void> {
  const { eq } = await import("drizzle-orm");
  const rows = await ctx.testDb.db
    .select({ current_version_id: workflows.current_version_id })
    .from(workflows)
    .where(eq(workflows.id, ctx.workflow_id));
  const current = rows[0]?.current_version_id;
  if (!current) throw new Error("workflow has no current version");
  await ctx.testDb.db
    .update(workflowVersions)
    .set({ dag: buildSeedDag(ctx.label, ctx.connector_id) })
    .where(eq(workflowVersions.id, current));
}

export async function createSelfHealingCtx(label: string): Promise<SelfHealingTestCtx> {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  const testDb = await createTestDb(`heal_${label}`);

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `t-${label}`, display_name: `Test ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");

  const [connector] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenant.id,
      slug: `api-${label}`,
      display_name: `API ${label}`,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
      config: {},
    })
    .returning();
  if (!connector) throw new Error("seed connector failed");

  const [workflow] = await testDb.db
    .insert(workflows)
    .values({
      tenant_id: tenant.id,
      slug: `wf-${label}`,
      name: `Workflow ${label}`,
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("seed workflow failed");

  const dag = buildSeedDag(label, connector.id);

  const [version] = await testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      version: 1,
      dag,
    })
    .returning();
  if (!version) throw new Error("seed workflow_versions failed");

  const { eq } = await import("drizzle-orm");
  await testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));

  const [execution] = await testDb.db
    .insert(executions)
    .values({
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      status: "failed",
      request_source: "api",
      execution_mode: "dev",
    })
    .returning();
  if (!execution) throw new Error("seed execution failed");

  const [step] = await testDb.db
    .insert(executionSteps)
    .values({
      tenant_id: tenant.id,
      execution_id: execution.id,
      step_key: SEED_STEP_ID,
      step_index: 0,
      kind: "request",
      status: "failed",
      request_meta: {
        driver: "http",
        method: "GET",
        url: "/users/1",
        connector: {
          step_key: "req-1",
          connector_id: "00000000-0000-0000-0000-000000000000",
          connector_slug: "stub",
          driver: "http",
          requested_environment: "dev",
          resolved_environment: "dev",
          auth_method: "none",
          base_url: null,
        },
      },
      error: {
        kind: "http",
        status: 404,
        body: { error: { code: "not_found", detail: "User not found" } },
      },
      output_preview: { data: { id: 1 } },
    })
    .returning();
  if (!step) throw new Error("seed execution_step failed");

  const endpoint_key = "GET /users/1";

  await testDb.db.insert(schemaVersions).values({
    tenant_id: tenant.id,
    connector_id: connector.id,
    endpoint_key,
    workflow_id: workflow.id,
    step_id: "req-1",
    schema: {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
          },
        },
      },
    },
  });

  const [fixture] = await testDb.db
    .insert(executionFixtures)
    .values({
      tenant_id: tenant.id,
      connector_id: connector.id,
      endpoint_key,
      kind: "fixture",
      request: { method: "GET", path: "/users/1" },
      response: { data: { result: { id: 42, name: "Ada" } } },
    })
    .returning();
  if (!fixture) throw new Error("seed execution_fixture failed");

  const cleanup = async () => {
    await testDb.cleanup();
  };

  return {
    testDb,
    label,
    tenant_id: tenant.id,
    connector_id: connector.id,
    workflow_id: workflow.id,
    workflow_version_id: version.id,
    execution_id: execution.id,
    step_id: step.id,
    fixture_id: fixture.id,
    endpoint_key,
    cleanup,
  };
}
