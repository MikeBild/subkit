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
    // Child workflow B
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
    // Parent workflow A
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
    // Regression: runCallStep passed `step.input` verbatim because callRunner
    // never received the scope. A chained workflow therefore handed the child
    // the literal string "${scope.prepare.data.runId}", which then landed in an
    // S3 key and failed with `Invalid key`. Arrays must survive as arrays — the
    // publish stage receives a list of revision ids, not its JSON text.
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
    // The child's recorded input is the direct evidence: pre-fix it held the
    // literal "${scope.prepare.data.runId}".
    const childInput = childRow?.input as { runId?: unknown; ids?: unknown } | null;
    expect(childInput?.runId).toBe("2026-07-28T031415Z");
    // An array, not its JSON text — type-preserving resolution.
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
    // Unlike a request body, the call input is STORED: createExecution keeps the
    // child's input verbatim so a rerun can default to it, and the execution read
    // schema serves that column to anything holding execution:read — including
    // the read-and-execute MCP tier. Resolving a credential here would write a
    // secret in clear text into a row that outlives the run and is readable from
    // a lower tier than the one that could read the credential itself.
    //
    // The refusal must happen BEFORE resolution, so the secret is never even
    // fetched. Nothing is lost: the child resolves the credential itself, at the
    // step that needs it.
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
          // Nested, to prove the scan walks the whole structure rather than
          // only checking top-level string leaves.
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

    // And no child execution row exists carrying that input — the refusal has to
    // land before runExecution, not after.
    const rows = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenantId));
    expect(rows.some((e) => e.workflow_id === child.workflow_id)).toBe(false);
  });

  test("`${input.…}` in a call input means the CALLING workflow's input", async () => {
    // The resolver context for a call step was copied from the request-step
    // dispatcher, which binds `input` to `scope.$input`. That binding was never
    // checked for calls, and it is the one place the answer is not obvious: a
    // call step is where a second workflow's input is being BUILT, so `input`
    // could plausibly have been read as the child's. It is the parent's — the
    // same thing `${input.…}` means in every other step of the same workflow.
    // Anything else would make one step kind read its own placeholders
    // differently from its neighbours.
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
