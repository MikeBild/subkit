import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditLog, executionSteps, executions, llmUsage } from "../../db/schema/index.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../../execution/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/index.ts";
import { journeyInvariantViolations } from "./invariants.ts";

const SECRET = "subkit-journey-secret-0123456789";
const uuid = createDeterministicUuidFactory(0x1a7);

let ctx: EngineTestCtx;
let workflowId = "";
let versionId = "";

beforeAll(async () => {
  ctx = await createEngineCtx("journey-invariants");
  const row = await createWorkflowRow(ctx, {
    name: "invariants",
    slug: "invariants",
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  workflowId = row.workflow_id;
  versionId = row.version_id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function execution(status: "running" | "succeeded", holdWrites = false): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(executions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: workflowId,
      workflow_version_id: versionId,
      source_kind: "saved",
      source_ref: null,
      status,
      request_source: "api",
      execution_mode: "dev",
      hold_writes: holdWrites,
    })
    .returning({ id: executions.id });
  if (!row) throw new Error("execution insert failed");
  return row.id;
}

function check(live: readonly string[] = []) {
  return journeyInvariantViolations({
    db: ctx.testDb.db,
    knownSecrets: [SECRET],
    logs: () => [],
    liveWorker: (id) => live.includes(id),
  });
}

describe("journey invariants", () => {
  test("a clean database has no violations", async () => {
    expect(await check()).toEqual([]);
  });

  test("each broken rule is named", async () => {
    const running = await execution("running");
    expect(await check([running])).toEqual([]);

    const unclosed = await execution("succeeded");
    await ctx.testDb.db.insert(auditLog).values({
      id: uuid(),
      tenant_id: ctx.tenantId,
      actor_type: "system",
      action: "execution.started",
      resource_type: "execution",
      resource_id: unclosed,
      result: "success",
    });
    await ctx.testDb.db.insert(executionSteps).values([
      {
        tenant_id: ctx.tenantId,
        execution_id: unclosed,
        step_key: "leak",
        kind: "transform",
        status: "succeeded",
        output_preview: { token: SECRET },
      },
      {
        tenant_id: ctx.tenantId,
        execution_id: unclosed,
        step_key: "write",
        kind: "request",
        status: "succeeded",
        held: true,
      },
    ]);
    await ctx.testDb.db.insert(llmUsage).values({
      tenant_id: ctx.tenantId,
      flow: "converse",
      model: "mock",
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 99,
      latency_ms: 1,
      result: "success",
      month_bucket: 202611,
    });

    const violations = await check();
    expect(violations).toContain(`execution ${running} is running without a live worker`);
    expect(violations).toContain(
      `execution ${unclosed} ended succeeded without a closing audit row`,
    );
    expect(violations.some((line) => line.includes("contains a secret value"))).toBe(true);
    expect(violations.some((line) => line.endsWith("does not add up"))).toBe(true);
    expect(
      violations.some((line) =>
        line.includes("belongs to a run that was not asked to hold writes"),
      ),
    ).toBe(true);
  });
});
