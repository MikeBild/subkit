// Integration test: MCP initialize returns non-empty instructions carrying
// the operator health/risk summary.
//
// When the health digest has something to report (failures or risks), the
// MCP `initialize` response MUST carry a non-empty `instructions` string
// containing the summary text. When the tenant is all-clear, the instructions
// string is the "all clear" sentence.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executionSteps, executions, workflows, workflowVersions } from "../../db/schema/index.ts";
import { _resetRssHighWaterForTests, setDlqJobCount } from "../../observability/instrumentation.ts";
import { resetMetricsRegistryForTests } from "../../observability/metrics.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("initialize-instructions");
});

afterAll(async () => {
  resetMetricsRegistryForTests();
  _resetRssHighWaterForTests();
  await suite.cleanup();
});

describe("mcp initialize — instructions field", () => {
  test("all-clear tenant receives the all-clear instructions string", async () => {
    // Ensure no metrics-driven risk signals are active.
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();

    const client = await suite.connect();
    const instructions = client.getInstructions();
    // The engine always sets instructions (either all-clear or a risk summary).
    expect(typeof instructions).toBe("string");
    expect(instructions!.length).toBeGreaterThan(0);
    // All-clear path produces the "Engine health: all clear" sentence.
    expect(instructions).toContain("all clear");
  });

  test("tenant with pending failures gets a non-empty instructions string carrying the headline", async () => {
    const db = suite.http.db;
    const tenantId = suite.http.tenantId;

    // Seed a failed execution so the digest is not all-clear.
    const [wf] = await db
      .insert(workflows)
      .values({
        tenant_id: tenantId,
        slug: "failing-wf-instr",
        name: "Failing Workflow",
        lifecycle: "active",
      })
      .returning();
    const [ver] = await db
      .insert(workflowVersions)
      .values({
        tenant_id: tenantId,
        workflow_id: wf!.id,
        version: 1,
        dag: { name: "Failing Workflow", steps: [] },
      })
      .returning();
    const [exec] = await db
      .insert(executions)
      .values({
        tenant_id: tenantId,
        workflow_id: wf!.id,
        workflow_version_id: ver!.id,
        source_kind: "saved",
        request_source: "scheduler",
        status: "failed",
        execution_mode: "dev",
      })
      .returning();
    await db.insert(executionSteps).values({
      tenant_id: tenantId,
      execution_id: exec!.id,
      step_key: "fetch",
      step_index: 0,
      kind: "request",
      status: "failed",
      error: { code: "http_4xx", message: "404 not found" },
    });

    // Connect a fresh client — each connection re-derives the digest.
    const client = await suite.connect();
    const instructions = client.getInstructions();
    expect(typeof instructions).toBe("string");
    expect(instructions!.length).toBeGreaterThan(0);
    // The digest headline describes the failure.
    expect(instructions).toContain("Needs attention");
  });

  test("tenant with a critical risk signal receives instructions carrying the risk summary", async () => {
    // Drive the DLQ gauge above the default threshold (5).
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();
    setDlqJobCount("execution.dlq", 10);

    const client = await suite.connect();
    const instructions = client.getInstructions();
    expect(typeof instructions).toBe("string");
    expect(instructions!.length).toBeGreaterThan(0);
    // The compact risk summary in instructions includes the signal headline.
    // The DLQ critical signal headline mentions "dead-letter".
    expect(instructions).toContain("dead-letter");
  });
});
