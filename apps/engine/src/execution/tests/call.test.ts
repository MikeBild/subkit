import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executions } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;

beforeAll(async () => {
  ctx = await createEngineCtx("call");
  mock = await createMockServer((_, res) => jsonResponse(res, 200, { hello: "world" }));
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("call step", () => {
  test("workflow A calls workflow B; child has parent + tool-chain", async () => {
    const child = await createWorkflowRow(ctx, {
      name: "child",
      slug: "child-flow",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/data`,
        },
      ],
    });
    const parent = await createWorkflowRow(ctx, {
      name: "parent",
      slug: "parent-flow",
      steps: [
        {
          kind: "call",
          id: "call_child",
          workflow_id: child.workflow_id,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: parent.workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    const all = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenantId));
    expect(all.length).toBeGreaterThanOrEqual(2);
    const childRow = all.find((e) => e.workflow_id === child.workflow_id);
    expect(childRow).toBeDefined();
    expect(childRow?.parent_execution_id).toBe(result.execution_id);
    expect(childRow?.request_source).toBe("tool-chain");
  });

  test("call input interpolates against the caller scope, preserving types", async () => {
    const child = await createWorkflowRow(ctx, {
      name: "child-echo",
      slug: "child-echo",
      steps: [
        {
          kind: "transform",
          id: "echo",
          language: "javascript",
          expression: "return { runId: input.input.runId, count: input.input.ids.length };",
        },
      ],
      output_transform: '{ "runId": $scope.echo.data.runId, "count": $scope.echo.data.count }',
    });
    const parent = await createWorkflowRow(ctx, {
      name: "parent-interp",
      slug: "parent-interp",
      steps: [
        {
          kind: "transform",
          id: "prepare",
          language: "javascript",
          expression: 'return { runId: "2026-07-28T031415Z", ids: ["a", "b", "c"] };',
        },
        {
          kind: "call",
          id: "call_child",
          workflow_id: child.workflow_id,
          input: { runId: "${scope.prepare.data.runId}", ids: "${scope.prepare.data.ids}" },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: parent.workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    const all = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenantId));
    const childRow = all.find((e) => e.workflow_id === child.workflow_id);
    const childInput = childRow?.input as { runId?: unknown; ids?: unknown } | null;
    expect(childInput?.runId).toBe("2026-07-28T031415Z");
    expect(Array.isArray(childInput?.ids)).toBe(true);
    expect(childInput?.ids).toEqual(["a", "b", "c"]);
  });

  test("an unresolvable placeholder fails the call instead of passing it through", async () => {
    const child = await createWorkflowRow(ctx, {
      name: "child-noop",
      slug: "child-noop",
      steps: [{ kind: "transform", id: "noop", language: "javascript", expression: "return {};" }],
    });
    const parent = await createWorkflowRow(ctx, {
      name: "parent-bad-ref",
      slug: "parent-bad-ref",
      steps: [
        {
          kind: "call",
          id: "call_child",
          workflow_id: child.workflow_id,
          input: { runId: "${scope.does_not_exist.data.runId}" },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: parent.workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
  });

  test("a credential placeholder is refused before it can be persisted", async () => {
    const child = await createWorkflowRow(ctx, {
      name: "child-cred",
      slug: "child-cred",
      steps: [{ kind: "transform", id: "noop", language: "javascript", expression: "return {};" }],
    });
    const parent = await createWorkflowRow(ctx, {
      name: "parent-cred-leak",
      slug: "parent-cred-leak",
      steps: [
        {
          kind: "call",
          id: "call_child",
          workflow_id: child.workflow_id,
          input: { auth: { token: "${cred.stripe.secret_key}" } },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: parent.workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");

    const rows = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenantId));
    expect(rows.some((e) => e.workflow_id === child.workflow_id)).toBe(false);
  });

  test("`${input.…}` in a call input means the CALLING workflow's input", async () => {
    const child = await createWorkflowRow(ctx, {
      name: "child-echo-parent-input",
      slug: "child-echo-parent-input",
      steps: [
        {
          kind: "transform",
          id: "echo",
          language: "javascript",
          expression: "return { seen: input.input.forwarded };",
        },
      ],
      output_transform: '{ "seen": $scope.echo.data.seen }',
    });
    const parent = await createWorkflowRow(ctx, {
      name: "parent-forwards-own-input",
      slug: "parent-forwards-own-input",
      steps: [
        {
          kind: "call",
          id: "call_child",
          workflow_id: child.workflow_id,
          input: { forwarded: "${input.ticket}" },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: parent.workflow_id },
      input: { ticket: "TCK-4711" },
    });
    expect(result.status).toBe("succeeded");

    const all = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenantId));
    const childRow = all.find((e) => e.workflow_id === child.workflow_id);
    const childInput = childRow?.input as { forwarded?: unknown } | null;
    expect(childInput?.forwarded).toBe("TCK-4711");
  });
});
