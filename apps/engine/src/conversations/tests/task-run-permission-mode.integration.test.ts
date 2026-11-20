import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  conversationMessages,
  conversations,
  conversationToolCalls,
  executions,
} from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { seedConnector } from "../../test-helpers/seed.ts";
import { registerConversationAbort, unregisterConversationAbort } from "../abort.ts";
import { listElicitationsForConversation } from "../elicitations.ts";
import { getStoredPermissionMode } from "../service/shared.ts";
import * as svc from "../service.ts";
import type { ConversationPermissionMode } from "../types.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  respondElicitationForTest,
} from "./setup.ts";
import {
  createRunConversation,
  driveTurn,
  lastPalette,
  markerFor,
  principalOf,
  seedRunnableWorkflow,
  toolCalls,
} from "./task-run-fixtures.ts";

let ctx: ConversationTestCtx;
let owner: ResolvedPrincipal;
const originalMasterKey = process.env.MASTER_KEY;
const REJECTED = { code: "task_run_permission_mode_rejected", status: 400 };

beforeAll(async () => {
  process.env.MASTER_KEY = "a".repeat(64);
  ctx = await createConversationTestCtx("task_run_mode");
  owner = principalOf(ctx, ctx.user_id, "admin");
}, 120_000);

afterAll(async () => {
  if (originalMasterKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = originalMasterKey;
  await ctx.cleanup();
}, 60_000);

async function storedMode(conversation_id: string): Promise<ConversationPermissionMode | null> {
  const detail = await svc.getConversation(ctx.tenant_id, conversation_id, ctx.testDb.db);
  return getStoredPermissionMode(detail?.draft);
}

async function forceStoredMode(conversation_id: string, mode: string): Promise<void> {
  const [row] = await ctx.testDb.db
    .select({ draft: conversations.draft })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation_id)));
  const draft = (row?.draft ?? {}) as { session?: Record<string, unknown> };
  await ctx.testDb.db
    .update(conversations)
    .set({ draft: { ...draft, session: { ...(draft.session ?? {}), permission_mode: mode } } })
    .where(and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversation_id)));
}

async function decidedModes(conversation_id: string): Promise<unknown[]> {
  const rows = await ctx.testDb.db
    .select()
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, ctx.tenant_id),
        eq(conversationToolCalls.conversation_id, conversation_id),
        eq(conversationToolCalls.tool, "run_workflow"),
      ),
    );
  expect(rows).toHaveLength(1);
  const text = JSON.stringify(rows);
  return [...new Set([...text.matchAll(/"permission_mode":"([a-z]+)"/g)].map((match) => match[1]))];
}

async function messageCount(conversation_id: string): Promise<number> {
  const rows = await ctx.testDb.db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, ctx.tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
      ),
    );
  return rows.length;
}

async function runs(workflow_id: string): Promise<number> {
  const rows = await ctx.testDb.db
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.workflow_id, workflow_id)));
  return rows.length;
}

function turnWithMode(conversation_id: string, permission_mode: ConversationPermissionMode) {
  const ctrl = registerConversationAbort(ctx.tenant_id, conversation_id);
  return svc
    .runConversationTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: owner.id,
        principal: owner,
        user_message: "Continue.",
        answer_actor: { kind: "human", user_id: owner.id, via: "chat" },
        permission_mode,
        turn_abort_ctrl: ctrl,
      },
      ctx.testDb.db,
    )
    .finally(() => unregisterConversationAbort(ctx.tenant_id, conversation_id, ctrl));
}

describe("a task run always decides in auto mode", () => {
  test("yolo in a message is rejected and nothing is stored", async () => {
    const conversation_id = await createRunConversation(ctx, owner.id, markerFor());
    await expect(
      svc.appendUserMessage(
        {
          tenant_id: ctx.tenant_id,
          conversation_id,
          actor_id: owner.id,
          principal: owner,
          message: "Just do it.",
          permission_mode: "yolo",
        },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject(REJECTED);
    expect(await messageCount(conversation_id)).toBe(0);
    expect(await storedMode(conversation_id)).toBe("auto");
  }, 60_000);

  test("yolo on a turn and on an answer is rejected", async () => {
    const conversation_id = await createRunConversation(ctx, owner.id, markerFor());
    await expect(turnWithMode(conversation_id, "yolo")).rejects.toMatchObject(REJECTED);
    const asked = await driveTurn(ctx, conversation_id, owner, [
      { tool: "ask_user_text", args: { question: "Which month?" } },
    ]);
    expect(asked.result.status).toBe("awaiting_input");
    const [pending] = (
      await listElicitationsForConversation(ctx.tenant_id, conversation_id, ctx.testDb.db)
    ).filter((row) => row.status === "pending");
    if (!pending) throw new Error("expected a pending question");
    await expect(
      respondElicitationForTest(
        {
          tenant_id: ctx.tenant_id,
          conversation_id,
          elicitation_id: pending.id,
          actor_id: owner.id,
          principal: owner,
          output: { text: "March" },
          permission_mode: "yolo",
        },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject(REJECTED);
    const after = await listElicitationsForConversation(
      ctx.tenant_id,
      conversation_id,
      ctx.testDb.db,
    );
    expect(after.find((row) => row.id === pending.id)?.status).toBe("pending");
  }, 120_000);

  test("another requested mode is ignored and never stored", async () => {
    const conversation_id = await createRunConversation(ctx, owner.id, markerFor());
    for (const mode of ["ask", "plan"] as const) {
      getMockProvider().setConversePlan(conversation_id, [{ text: "Noted." }]);
      await appendMessageWithTurn(
        {
          tenant_id: ctx.tenant_id,
          conversation_id,
          actor_id: owner.id,
          principal: owner,
          message: "Continue.",
          permission_mode: mode,
        },
        ctx.testDb.db,
      );
      expect(await storedMode(conversation_id)).toBe("auto");
    }
  }, 120_000);

  test("a stored yolo mode is not the mode a task run decides on", async () => {
    const workflow = await seedRunnableWorkflow(ctx, "mode-bound");
    const run = { tool: "run_workflow", args: { workflow: workflow.slug } };
    const marked = await createRunConversation(
      ctx,
      owner.id,
      markerFor({ workflow_ids: [workflow.id] }),
    );
    await forceStoredMode(marked, "yolo");
    const own = `wf_${workflow.slug}`;
    await driveTurn(ctx, marked, owner, [{ tool: own, args: {} }, { text: "Started." }]);
    expect(lastPalette()).not.toContain("run_workflow");
    expect((await toolCalls(ctx, marked)).map((row) => row.tool)).toEqual([own]);

    const ordinary = await createRunConversation(ctx, owner.id, null);
    getMockProvider().setConversePlan(ordinary, [run, { text: "Started." }]);
    await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: ordinary,
        actor_id: owner.id,
        principal: owner,
        message: "Continue with the task.",
        permission_mode: "yolo",
      },
      ctx.testDb.db,
    );
    expect(await decidedModes(ordinary)).toEqual(["yolo"]);
  }, 120_000);

  test("a write through a bound connector asks even when yolo is stored", async () => {
    const connector = await seedConnector(ctx.testDb.db, {
      tenant_id: ctx.tenant_id,
      slug: "mode-bound-api",
    });
    const marked = await createRunConversation(
      ctx,
      owner.id,
      markerFor({ connector_ids: [connector.id] }),
    );
    await forceStoredMode(marked, "yolo");
    const asked = await driveTurn(ctx, marked, owner, [
      {
        tool: "call_connector",
        args: { connector_id: connector.id, method: "POST", path: "/things", body: {} },
      },
    ]);
    expect(asked.result.status).toBe("awaiting_input");
  }, 120_000);

  test("an ordinary conversation still accepts yolo", async () => {
    const conversation_id = await createRunConversation(ctx, owner.id, null);
    getMockProvider().setConversePlan(conversation_id, [{ text: "Ok." }]);
    const outcome = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: owner.id,
        principal: owner,
        message: "Continue.",
        permission_mode: "yolo",
      },
      ctx.testDb.db,
    );
    expect(outcome.result.status).toBe("active");
  }, 120_000);
});

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

  test("the fast path decides on the mode of the turn, not the stored one", async () => {
    const workflow = await seedRunnableWorkflow(ctx, "fastmode");
    const conversation_id = await createRunConversation(ctx, owner.id, null);
    expect(await storedMode(conversation_id)).toBe("auto");
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
          permission_mode: "plan",
          turn_abort_ctrl: ctrl,
        },
        ctx.testDb.db,
      )
      .finally(() => unregisterConversationAbort(ctx.tenant_id, conversation_id, ctrl));
    expect(outcome.result.status).toBe("awaiting_input");
    expect(await runs(workflow.id)).toBe(0);
  }, 120_000);
});
