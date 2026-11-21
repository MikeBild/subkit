import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executions } from "../../db/schema/index.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { getTool } from "../tools/index.ts";
import { taskRunToolRefusal } from "../tools/sdk-wrap/task-run-guard.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";
import {
  createRunConversation,
  driveTurn,
  lastPalette,
  markerFor,
  principalOf,
  sealConversation,
  seedBoundConnector,
  seedRunnableWorkflow,
  toolCalls,
} from "./task-run-fixtures.ts";

let ctx: ConversationTestCtx;
let owner: ResolvedPrincipal;
let bound: Awaited<ReturnType<typeof seedRunnableWorkflow>>;
let unbound: Awaited<ReturnType<typeof seedRunnableWorkflow>>;
let boundConnector: Awaited<ReturnType<typeof seedBoundConnector>>;
let unboundConnector: Awaited<ReturnType<typeof seedBoundConnector>>;

const originalMasterKey = testEnv.MASTER_KEY;

beforeAll(async () => {
  testEnv.MASTER_KEY = "a".repeat(64);
  ctx = await createConversationTestCtx("task_run_bindings");
  owner = principalOf(ctx, ctx.user_id, "admin");
  bound = await seedRunnableWorkflow(ctx, "bound-report");
  unbound = await seedRunnableWorkflow(ctx, "unbound-report");
  boundConnector = await seedBoundConnector(ctx, "bound-api");
  unboundConnector = await seedBoundConnector(ctx, "unbound-api");
}, 120_000);

afterAll(async () => {
  if (originalMasterKey === undefined) delete testEnv.MASTER_KEY;
  else testEnv.MASTER_KEY = originalMasterKey;
  await ctx.cleanup();
}, 60_000);

async function runs(workflow_id: string) {
  return ctx.testDb.db
    .select({ id: executions.id, execution_mode: executions.execution_mode })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, workflow_id)));
}

function errorCode(output: unknown): unknown {
  const record = (output ?? {}) as { error_code?: unknown; error?: { code?: unknown } };
  return record.error_code ?? record.error?.code;
}

describe("a task run acts only inside its bindings", () => {
  test("a workflow outside the bindings is refused and never starts", async () => {
    const conversation_id = await createRunConversation(
      ctx,
      ctx.user_id,
      markerFor({ workflow_ids: [bound.id] }),
    );
    await driveTurn(ctx, conversation_id, owner, [
      { text: "That workflow is not part of this task." },
    ]);
    const palette = lastPalette();
    expect(palette).not.toContain("run_workflow");
    expect(palette).not.toContain(`wf_${unbound.slug}`);
    const tool = getTool("run_workflow");
    if (!tool) throw new Error("run_workflow is not registered");
    const refusal = await taskRunToolRefusal(
      tool,
      markerFor({ workflow_ids: [bound.id] }),
      { db: ctx.testDb.db, tenant_id: ctx.tenant_id } as never,
      { workflow: unbound.slug },
    );
    expect(errorCode(refusal)).toBe("task_run_workflow_not_bound");
    expect(await runs(unbound.id)).toHaveLength(0);
  }, 120_000);

  test("only bound workflows get a direct tool, and a bound one runs in the task environment", async () => {
    const conversation_id = await createRunConversation(
      ctx,
      ctx.user_id,
      markerFor({ workflow_ids: [bound.id], environment: "prod" }),
    );
    await driveTurn(ctx, conversation_id, owner, [
      { tool: `wf_${bound.slug}`, args: {} },
      { text: "Started." },
    ]);
    const palette = lastPalette();
    expect(palette).toContain(`wf_${bound.slug}`);
    expect(palette).not.toContain(`wf_${unbound.slug}`);
    const started = await runs(bound.id);
    expect(started.length).toBeGreaterThan(0);
    expect(started.every((row) => row.execution_mode === "prod")).toBe(true);
  }, 120_000);

  test("the generic run tool is refused in a run and names the workflow's own tool", async () => {
    const tool = getTool("run_workflow");
    if (!tool) throw new Error("run_workflow is not registered");
    const refusal = await taskRunToolRefusal(
      tool,
      markerFor({ workflow_ids: [bound.id], environment: "dev" }),
      { db: ctx.testDb.db, tenant_id: ctx.tenant_id } as never,
      { workflow: bound.slug, environment: "prod" },
    );
    expect(errorCode(refusal)).toBe("task_run_use_workflow_tool");
    expect(JSON.stringify(refusal)).toContain(`wf_${bound.slug}`);
  }, 120_000);

  test("a connector outside the bindings is refused before anything is asked or sent", async () => {
    const conversation_id = await createRunConversation(
      ctx,
      ctx.user_id,
      markerFor({ connector_ids: [boundConnector.id] }),
    );
    const outcome = await driveTurn(ctx, conversation_id, owner, [
      {
        tool: "call_connector",
        args: { connector_id: unboundConnector.id, method: "POST", path: "/things", body: {} },
      },
      { text: "That connector is not part of this task." },
    ]);
    expect(outcome.result.status).not.toBe("awaiting_input");
    const call = (await toolCalls(ctx, conversation_id)).find(
      (row) => row.tool === "call_connector",
    );
    expect(call?.outcome).not.toBe("ok");
    expect(JSON.stringify(call?.output)).toMatch(
      /task_run_connector_not_bound|connector_not_in_allowlist/,
    );
  }, 120_000);

  test("a write through a bound connector still asks first", async () => {
    const conversation_id = await createRunConversation(
      ctx,
      ctx.user_id,
      markerFor({ connector_ids: [boundConnector.id] }),
    );
    const outcome = await driveTurn(ctx, conversation_id, owner, [
      {
        tool: "call_connector",
        args: { connector_id: boundConnector.id, method: "POST", path: "/things", body: {} },
      },
    ]);
    expect(outcome.result.status).toBe("awaiting_input");
  }, 120_000);

  test("a sealed run conversation refuses every acting tool and offers no direct workflow tool", async () => {
    const conversation_id = await createRunConversation(
      ctx,
      ctx.user_id,
      markerFor({ workflow_ids: [bound.id], connector_ids: [boundConnector.id] }),
    );
    await sealConversation(ctx, conversation_id);
    const before = (await runs(bound.id)).length;
    await driveTurn(ctx, conversation_id, owner, [
      { tool: "call_connector", args: { connector_id: boundConnector.id, path: "/things" } },
      { tool: "schedule_task_check", args: { in_minutes: 30, reason: "look again" } },
      { text: "Nothing is bound." },
    ]);
    expect(lastPalette().filter((name) => name.startsWith("wf_"))).toEqual([]);
    const calls = await toolCalls(ctx, conversation_id);
    for (const tool of ["call_connector", "schedule_task_check"]) {
      const call = calls.find((row) => row.tool === tool);
      expect(call?.outcome).not.toBe("ok");
      expect(JSON.stringify(call?.output)).toMatch(/task_run_sealed|not_in_allowlist/);
    }
    expect(await runs(bound.id)).toHaveLength(before);
  }, 120_000);

  test("an ordinary conversation still runs any workflow the person may run", async () => {
    const conversation_id = await createRunConversation(ctx, ctx.user_id, null);
    const before = (await runs(unbound.id)).length;
    await driveTurn(ctx, conversation_id, owner, [
      { tool: "run_workflow", args: { workflow: unbound.slug } },
      { text: "Started." },
    ]);
    expect((await runs(unbound.id)).length).toBe(before + 1);
    expect(lastPalette()).not.toContain("schedule_task_check");
  }, 120_000);
});
