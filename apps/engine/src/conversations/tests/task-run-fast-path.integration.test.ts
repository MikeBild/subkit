import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executions } from "../../db/schema/index.ts";
import { writeSetupPreferences } from "../../identity/setup-preferences.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { registerConversationAbort, unregisterConversationAbort } from "../abort.ts";
import * as svc from "../service/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";
import {
  createRunConversation,
  driveTurn,
  markerFor,
  principalOf,
  seedRunnableWorkflow,
  toolCalls,
} from "./task-run-fixtures.ts";

let ctx: ConversationTestCtx;
let owner: ResolvedPrincipal;
const originalMasterKey = testEnv.MASTER_KEY;

beforeAll(async () => {
  testEnv.MASTER_KEY = "a".repeat(64);
  ctx = await createConversationTestCtx("task_run_fast_path");
  owner = principalOf(ctx, ctx.user_id, "admin");
}, 120_000);

afterAll(async () => {
  if (originalMasterKey === undefined) delete testEnv.MASTER_KEY;
  else testEnv.MASTER_KEY = originalMasterKey;
  await ctx.cleanup();
}, 60_000);

async function runs(workflow_id: string): Promise<number> {
  const rows = await ctx.testDb.db
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, workflow_id)));
  return rows.length;
}

describe("the fast path and a task run", () => {
  test("a run command in a task run goes through the guarded model turn, not the fast path", async () => {
    const bound = await seedRunnableWorkflow(ctx, "fastbound");
    const other = await seedRunnableWorkflow(ctx, "fastother");
    const marked = await createRunConversation(
      ctx,
      owner.id,
      markerFor({ workflow_ids: [bound.id] }),
    );
    const callsBefore = getMockProvider().calls.length;
    await driveTurn(ctx, marked, owner, [{ text: "Not part of this task." }], `run ${other.slug}`);
    expect(getMockProvider().calls.length).toBeGreaterThan(callsBefore);
    expect(await runs(other.id)).toBe(0);
    expect((await toolCalls(ctx, marked)).map((row) => row.tool)).toEqual([]);

    const ordinary = await createRunConversation(ctx, owner.id, null);
    const callsMid = getMockProvider().calls.length;
    await driveTurn(ctx, ordinary, owner, [], `run ${other.slug}`);
    expect(getMockProvider().calls.length).toBe(callsMid);
    expect(await runs(other.id)).toBe(1);
  }, 120_000);

  test("the fast path asks when the person's rule says to ask before writing", async () => {
    const workflow = await seedRunnableWorkflow(ctx, "fastmode");
    await writeSetupPreferences(
      ctx.testDb.db,
      { tenant_id: ctx.tenant_id, user_id: owner.id },
      { ask_before_writing: true },
    );
    const conversation_id = await createRunConversation(ctx, owner.id, null);
    getMockProvider().setConversePlan(conversation_id, []);
    const appended = await svc.appendUserMessage(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: owner.id,
        principal: owner,
        message: `run ${workflow.slug}`,
      },
      ctx.testDb.db,
    );
    const ctrl = registerConversationAbort(ctx.tenant_id, conversation_id);
    const outcome = await svc
      .runConversationTurn(
        {
          tenant_id: ctx.tenant_id,
          conversation_id,
          actor_id: owner.id,
          principal: owner,
          user_message: appended.message,
          answer_actor: { kind: "human", user_id: owner.id, via: "chat" },
          turn_abort_ctrl: ctrl,
        },
        ctx.testDb.db,
      )
      .finally(() => unregisterConversationAbort(ctx.tenant_id, conversation_id, ctrl));
    expect(outcome.result.status).toBe("awaiting_input");
    expect(await runs(workflow.id)).toBe(0);
  }, 120_000);
});
