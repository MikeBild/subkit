// Unit tests for the proactive drift scanner.
//
// The scanner is pure DB read: no LLM, no network. Tests seed each
// of the three drift surfaces in isolation and assert that
// scanForDrift returns exactly the expected signals.
//
//   * stdlib_version_drift — covered already by stdlib-drift-scan.test.ts;
//     this file checks the scanner glue that lifts those signals
//     into the ScannedSignal envelope.
//   * schema_diff          — two recorded shapes for one (connector,
//     endpoint); the older shape vs the newer shape must produce
//     a non-empty diff.
//   * validation_failed    — a workflow with a validation_expression
//     in its dag whose latest execution failed AFTER a prior success
//     on the same workflow_version.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  connectors,
  executions,
  schemaVersions,
  tenants,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { scanForDrift } from "../proactive-scanner.ts";

// Deterministic timestamps derived from the frozen test clock so the
// scanner's "two recorded shapes, newer one differs" ordering is
// reproducible across runs.
const TEST_NOW = getTestNow();
const NOW = new Date(TEST_NOW);
const SIXTY_S_AGO = new Date(TEST_NOW - 60_000);
const TWO_MIN_AGO = new Date(TEST_NOW - 120_000);

let testDb: TestDb;
let tenantId: string;

beforeEach(async () => {
  testDb = await createTestDb("proactive-scan");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "proactive-scan", display_name: "Proactive Scan" })
    .returning();
  if (!tenant) throw new Error("tenant insert failed");
  tenantId = tenant.id;
});

afterEach(async () => {
  await testDb.cleanup();
});

async function seedWorkflowWithConnector(opts: {
  validationExpression?: string;
  stdlibVersion?: string;
}): Promise<{ workflow_id: string; workflow_version_id: string; connector_id: string }> {
  const [connector] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "api",
      display_name: "API",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
      config: {},
    })
    .returning();
  if (!connector) throw new Error("connector insert failed");

  const [workflow] = await testDb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug: "wf",
      name: "Workflow",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("workflow insert failed");

  const dag: Record<string, unknown> = {
    name: "Workflow",
    steps: [
      {
        kind: "request",
        id: "r",
        method: "GET",
        connector_id: connector.id,
        path: "/users/1",
      },
    ],
  };
  if (opts.validationExpression) dag.validation_expression = opts.validationExpression;
  if (opts.stdlibVersion) dag.runtime = { stdlib_version: opts.stdlibVersion };

  const [version] = await testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: workflow.id,
      version: 1,
      dag,
    })
    .returning();
  if (!version) throw new Error("version insert failed");

  const { eq } = await import("drizzle-orm");
  await testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));

  return {
    workflow_id: workflow.id,
    workflow_version_id: version.id,
    connector_id: connector.id,
  };
}

async function seedWorkflowForConnector(
  connectorId: string,
  suffix: string,
): Promise<{ workflow_id: string; step_id: string }> {
  const stepId = `request-${suffix}`;
  const [workflow] = await testDb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug: `wf-${suffix}`,
      name: `Workflow ${suffix}`,
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("workflow insert failed");
  const [version] = await testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenantId,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: `Workflow ${suffix}`,
        steps: [
          {
            kind: "request",
            id: stepId,
            method: "GET",
            connector_id: connectorId,
            path: "/users/1",
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("version insert failed");
  const { eq } = await import("drizzle-orm");
  await testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  return { workflow_id: workflow.id, step_id: stepId };
}

describe("scanForDrift", () => {
  test("empty tenant yields no signals", async () => {
    const result = await scanForDrift({ tenant_id: tenantId }, testDb.db);
    expect(result.signals).toEqual([]);
    expect(result.unanchored).toEqual([]);
  });

  test("request_hook stdlib drift lands in the unanchored bucket", async () => {
    const { requestHooks } = await import("../../db/schema/index.ts");
    await testDb.db.insert(requestHooks).values({
      tenant_id: tenantId,
      role: "member",
      source: "return sk.allow();",
      version: 1,
      enabled: true,
      stdlib_version: "0.1.0",
    });
    const result = await scanForDrift({ tenant_id: tenantId }, testDb.db);
    expect(result.signals).toEqual([]);
    expect(result.unanchored.length).toBe(1);
    expect(result.unanchored[0]?.reason).toBe("hook_surface_not_supported");
    expect(result.unanchored[0]?.signal.kind).toBe("stdlib_version_drift");
  });

  test("legacy schema rows without provenance cannot create a workflow candidate", async () => {
    // Seed an isolated connector that no workflow references.
    const { connectors } = await import("../../db/schema/index.ts");
    const [orphan] = await testDb.db
      .insert(connectors)
      .values({
        tenant_id: tenantId,
        slug: "orphan",
        display_name: "Orphan",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://example.test",
        config: {},
      })
      .returning();
    if (!orphan) throw new Error("orphan connector insert failed");
    await testDb.db.insert(schemaVersions).values([
      {
        tenant_id: tenantId,
        connector_id: orphan.id,
        endpoint_key: "GET /x",
        schema: { type: "object", properties: { a: { type: "number" } } },
        seen_at: SIXTY_S_AGO,
      },
      {
        tenant_id: tenantId,
        connector_id: orphan.id,
        endpoint_key: "GET /x",
        schema: { type: "object", properties: { a: { type: "string" } } },
        seen_at: NOW,
      },
    ]);
    const result = await scanForDrift({ tenant_id: tenantId }, testDb.db);
    expect(result.signals.filter((s) => s.signal.kind === "schema_diff")).toEqual([]);
    expect(result.unanchored.filter((u) => u.reason === "no_workflow_anchor")).toEqual([]);
  });

  test("stdlib drift on a workflow surfaces a workflow-scoped signal", async () => {
    const { workflow_id } = await seedWorkflowWithConnector({ stdlibVersion: "0.9.0" });
    const result = await scanForDrift({ tenant_id: tenantId }, testDb.db);
    const stdlib = result.signals.filter((s) => s.signal.kind === "stdlib_version_drift");
    expect(stdlib.length).toBe(1);
    expect(stdlib[0]?.ctx.workflow_id).toBe(workflow_id);
    expect(stdlib[0]?.ctx.repair_input.failing_step_id).toContain("proactive:stdlib");
  });

  test("schema drift between two recorded shapes emits a schema_diff signal", async () => {
    const { workflow_id, connector_id } = await seedWorkflowWithConnector({});

    // Older shape — observed first.
    await testDb.db.insert(schemaVersions).values({
      tenant_id: tenantId,
      connector_id,
      endpoint_key: "GET /users/1",
      workflow_id,
      step_id: "r",
      schema: {
        type: "object",
        properties: {
          data: { type: "object", properties: { id: { type: "number" } } },
        },
      },
      seen_at: SIXTY_S_AGO,
    });
    // Newer shape changes a nested type and also adds a compatible key.
    await testDb.db.insert(schemaVersions).values({
      tenant_id: tenantId,
      connector_id,
      endpoint_key: "GET /users/1",
      workflow_id,
      step_id: "r",
      schema: {
        type: "object",
        properties: {
          data: { type: "object", properties: { id: { type: "string" } } },
          meta: { type: "string" },
        },
      },
      seen_at: NOW,
    });

    const result = await scanForDrift({ tenant_id: tenantId }, testDb.db);
    const schema = result.signals.filter((s) => s.signal.kind === "schema_diff");
    expect(schema.length).toBe(1);
    const sig = schema[0];
    if (sig?.signal.kind !== "schema_diff") throw new Error("expected schema_diff");
    expect(sig.signal.added).toContain("meta");
    expect(sig.signal.widened).toContain("data.id");
    expect(sig.ctx.workflow_id).toBe(workflow_id);
    expect(sig.ctx.connector_id).toBe(connector_id);
    expect(sig.ctx.endpoint_key).toBe("GET /users/1");
  });

  test("schema drift is suppressed when only one shape is recorded", async () => {
    const { connector_id, workflow_id } = await seedWorkflowWithConnector({});
    await testDb.db.insert(schemaVersions).values({
      tenant_id: tenantId,
      connector_id,
      endpoint_key: "GET /users/1",
      workflow_id,
      step_id: "r",
      schema: { type: "object", properties: {} },
    });
    const result = await scanForDrift({ tenant_id: tenantId }, testDb.db);
    expect(result.signals.filter((s) => s.signal.kind === "schema_diff")).toEqual([]);
  });

  test("validation drift fires when latest execution failed after a prior success", async () => {
    const { workflow_id, workflow_version_id } = await seedWorkflowWithConnector({
      validationExpression: "count > 0",
    });

    // Older succeeded execution.
    await testDb.db.insert(executions).values({
      tenant_id: tenantId,
      workflow_id,
      workflow_version_id,
      status: "succeeded",
      request_source: "api",
      execution_mode: "dev",
      started_at: TWO_MIN_AGO,
    });
    // Newer failed execution.
    await testDb.db.insert(executions).values({
      tenant_id: tenantId,
      workflow_id,
      workflow_version_id,
      status: "failed",
      request_source: "api",
      execution_mode: "dev",
      started_at: NOW,
    });

    const result = await scanForDrift({ tenant_id: tenantId }, testDb.db);
    const validation = result.signals.filter((s) => s.signal.kind === "validation_failed");
    expect(validation.length).toBe(1);
    const sig = validation[0];
    if (sig?.signal.kind !== "validation_failed") throw new Error("expected validation");
    expect(sig.signal.expression).toBe("count > 0");
    expect(sig.ctx.workflow_id).toBe(workflow_id);
  });

  test("validation drift stays silent when there is no prior success", async () => {
    const { workflow_id, workflow_version_id } = await seedWorkflowWithConnector({
      validationExpression: "count > 0",
    });
    // Only one execution, and it failed. Without a prior succeeded
    // execution we don't have evidence of drift.
    await testDb.db.insert(executions).values({
      tenant_id: tenantId,
      workflow_id,
      workflow_version_id,
      status: "failed",
      request_source: "api",
      execution_mode: "dev",
      started_at: NOW,
    });
    const result = await scanForDrift({ tenant_id: tenantId }, testDb.db);
    expect(result.signals.filter((s) => s.signal.kind === "validation_failed")).toEqual([]);
  });

  test("connector_id filter restricts schema scanning", async () => {
    const { connector_id, workflow_id } = await seedWorkflowWithConnector({});
    // Seed drift on the workflow's connector.
    await testDb.db.insert(schemaVersions).values([
      {
        tenant_id: tenantId,
        connector_id,
        endpoint_key: "GET /users/1",
        workflow_id,
        step_id: "r",
        schema: { type: "object", properties: { id: { type: "number" } } },
        seen_at: SIXTY_S_AGO,
      },
      {
        tenant_id: tenantId,
        connector_id,
        endpoint_key: "GET /users/1",
        workflow_id,
        step_id: "r",
        schema: { type: "object", properties: { id: { type: "string" } } },
        seen_at: NOW,
      },
    ]);
    // Filter to a different connector — nothing should match.
    const other = "11111111-1111-1111-1111-111111111111";
    const result = await scanForDrift({ tenant_id: tenantId, connector_id: other }, testDb.db);
    expect(result.signals.filter((s) => s.signal.kind === "schema_diff")).toEqual([]);
  });

  test("the same connector endpoint stays isolated across workflows and steps", async () => {
    const first = await seedWorkflowWithConnector({});
    const second = await seedWorkflowForConnector(first.connector_id, "shared");
    await testDb.db.insert(schemaVersions).values([
      {
        tenant_id: tenantId,
        connector_id: first.connector_id,
        endpoint_key: "GET /users/1",
        workflow_id: first.workflow_id,
        step_id: "r",
        schema: { type: "object", properties: { id: { type: "number" } } },
        seen_at: SIXTY_S_AGO,
      },
      {
        tenant_id: tenantId,
        connector_id: first.connector_id,
        endpoint_key: "GET /users/1",
        workflow_id: first.workflow_id,
        step_id: "r",
        schema: { type: "object", properties: { id: { type: "string" } } },
        seen_at: NOW,
      },
      {
        tenant_id: tenantId,
        connector_id: first.connector_id,
        endpoint_key: "GET /users/1",
        workflow_id: second.workflow_id,
        step_id: second.step_id,
        schema: { type: "object", properties: { id: { type: "number" } } },
        seen_at: SIXTY_S_AGO,
      },
      {
        tenant_id: tenantId,
        connector_id: first.connector_id,
        endpoint_key: "GET /users/1",
        workflow_id: second.workflow_id,
        step_id: second.step_id,
        schema: {
          type: "object",
          properties: { id: { type: "number" }, optional: { type: "string" } },
        },
        seen_at: NOW,
      },
    ]);

    const result = await scanForDrift({ tenant_id: tenantId }, testDb.db);
    const schema = result.signals.filter((signal) => signal.signal.kind === "schema_diff");
    expect(schema).toHaveLength(1);
    expect(schema[0]?.ctx.workflow_id).toBe(first.workflow_id);
    expect(schema[0]?.ctx.repair_input.failing_step_id).toContain(":r");
  });
});
