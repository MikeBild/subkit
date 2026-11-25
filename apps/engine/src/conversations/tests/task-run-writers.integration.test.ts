import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { conversationMessages, conversations } from "../../db/schema/index.ts";
import { registerConversationAbort, unregisterConversationAbort } from "../abort.ts";
import { MODEL_RELAYED_ANSWER } from "../answer-actor.ts";
import { getTaskRunCheck } from "../core/draft.ts";
import { DirectInvokeError, invokeConversationToolDirect } from "../direct-invoke.ts";
import { listElicitationsForConversation } from "../elicitations.ts";
import * as svc from "../service/index.ts";
import { getToolPolicies, setToolPolicies } from "../tool-policies.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  respondElicitationForTest,
} from "./setup.ts";
import {
  createRunConversation,
  driveTurn,
  markerFor,
  principalOf,
  seedUser,
  storedMarker,
} from "./task-run-fixtures.ts";

let ctx: ConversationTestCtx;
let owner: ResolvedPrincipal;
let stranger: ResolvedPrincipal;
let admin: ResolvedPrincipal;

const FORBIDDEN = { code: "task_run_write_forbidden", status: 403 };
const LOCKED = { code: "task_run_locked", status: 409 };

beforeAll(async () => {
  ctx = await createConversationTestCtx("task_run_writers");
  owner = principalOf(ctx, await seedUser(ctx, "owner", "member"), "member");
  stranger = principalOf(ctx, await seedUser(ctx, "stranger", "member"), "member");
  admin = principalOf(ctx, ctx.user_id, "admin");
}, 120_000);

afterAll(async () => {
  await ctx.cleanup();
}, 60_000);

async function userMessages(conversation_id: string): Promise<number> {
  const rows = await ctx.testDb.db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, ctx.tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
        eq(conversationMessages.role, "user"),
      ),
    );
  return rows.length;
}

function runConversation(): Promise<string> {
  return createRunConversation(ctx, owner.id, markerFor());
}

async function runTurn(
  conversation_id: string,
  who: ResolvedPrincipal | null,
  actor_id: string | null,
): Promise<svc.ConversationTurnOutcome> {
  const ctrl = registerConversationAbort(ctx.tenant_id, conversation_id);
  try {
    return await svc.runConversationTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id,
        principal: who,
        user_message: "Continue.",
        answer_actor: MODEL_RELAYED_ANSWER,
        turn_abort_ctrl: ctrl,
      },
      ctx.testDb.db,
    );
  } finally {
    unregisterConversationAbort(ctx.tenant_id, conversation_id, ctrl);
  }
}

describe("only the task owner or an admin writes in a run conversation", () => {
  test("another member cannot append a message; the owner and an admin can", async () => {
    const conversation_id = await runConversation();
    await expect(
      svc.appendUserMessage(
        {
          tenant_id: ctx.tenant_id,
          conversation_id,
          actor_id: stranger.id,
          principal: stranger,
          message: "Do something else.",
        },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject(FORBIDDEN);
    await expect(
      svc.appendUserMessage(
        { tenant_id: ctx.tenant_id, conversation_id, actor_id: stranger.id, message: "No." },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject(FORBIDDEN);
    await expect(
      svc.appendUserMessage(
        { tenant_id: ctx.tenant_id, conversation_id, actor_id: null, message: "Anonymous." },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(await userMessages(conversation_id)).toBe(0);
    for (const who of [owner, admin]) {
      await svc.appendUserMessage(
        {
          tenant_id: ctx.tenant_id,
          conversation_id,
          actor_id: who.id,
          principal: who,
          message: "Carry on.",
        },
        ctx.testDb.db,
      );
    }
    await svc.appendUserMessage(
      { tenant_id: ctx.tenant_id, conversation_id, actor_id: admin.id, message: "Carry on." },
      ctx.testDb.db,
    );
    expect(await userMessages(conversation_id)).toBe(3);
  }, 120_000);

  test("a turn is refused for another member, for no principal, and runs for the owner", async () => {
    const conversation_id = await runConversation();
    await expect(runTurn(conversation_id, stranger, stranger.id)).rejects.toMatchObject(FORBIDDEN);
    await expect(runTurn(conversation_id, null, null)).rejects.toMatchObject(FORBIDDEN);
    await expect(runTurn(conversation_id, null, owner.id)).rejects.toMatchObject(FORBIDDEN);
    const outcome = await driveTurn(ctx, conversation_id, owner, [{ text: "Nothing to do yet." }]);
    expect(outcome.result.status).toBe("active");
    const asAdmin = await driveTurn(ctx, conversation_id, admin, [{ text: "Looked at it." }]);
    expect(asAdmin.result.status).toBe("active");
  }, 120_000);

  test("an open question is answered only by the owner or an admin", async () => {
    for (const answerer of [owner, admin]) {
      const conversation_id = await runConversation();
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
            actor_id: stranger.id,
            principal: stranger,
            output: { text: "March" },
          },
          ctx.testDb.db,
        ),
      ).rejects.toMatchObject(FORBIDDEN);
      const still = await listElicitationsForConversation(
        ctx.tenant_id,
        conversation_id,
        ctx.testDb.db,
      );
      expect(still.find((row) => row.id === pending.id)?.status).toBe("pending");
      const answered = await respondElicitationForTest(
        {
          tenant_id: ctx.tenant_id,
          conversation_id,
          elicitation_id: pending.id,
          actor_id: answerer.id,
          principal: answerer,
          output: { text: "March" },
        },
        ctx.testDb.db,
      );
      expect(answered.result.status).toBe("active");
    }
  }, 180_000);

  test("compacting, undoing and renaming are refused for another member", async () => {
    const conversation_id = await runConversation();
    await expect(
      svc.compactConversation(
        { tenant_id: ctx.tenant_id, conversation_id, actor_id: stranger.id, principal: stranger },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject(FORBIDDEN);
    await expect(
      svc.undoLastDraftMutation(ctx.tenant_id, conversation_id, ctx.testDb.db, {
        actor_id: stranger.id,
        principal: stranger,
      }),
    ).rejects.toMatchObject(FORBIDDEN);
    await expect(
      svc.undoLastDraftMutation(ctx.tenant_id, conversation_id, ctx.testDb.db),
    ).rejects.toMatchObject(FORBIDDEN);
    await expect(
      svc.patchConversation(
        { tenant_id: ctx.tenant_id, conversation_id, actor_id: stranger.id, title: "Mine now" },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject(FORBIDDEN);
    await svc.compactConversation(
      { tenant_id: ctx.tenant_id, conversation_id, actor_id: owner.id, principal: owner },
      ctx.testDb.db,
    );
    await svc.undoLastDraftMutation(ctx.tenant_id, conversation_id, ctx.testDb.db, {
      actor_id: admin.id,
      principal: admin,
    });
    const renamed = await svc.patchConversation(
      { tenant_id: ctx.tenant_id, conversation_id, actor_id: owner.id, title: "Monthly report" },
      ctx.testDb.db,
    );
    expect(renamed?.title).toBe("Monthly report");
    expect(await storedMarker(ctx, conversation_id)).toEqual(markerFor());
  }, 120_000);

  test("confirmation settings cannot be changed by anyone in a run conversation", async () => {
    const conversation_id = await runConversation();
    for (const who of [stranger, owner, admin]) {
      await expect(
        setToolPolicies(
          ctx.testDb.db,
          ctx.tenant_id,
          conversation_id,
          { run_workflow: "confirm_before_execution" },
          { actor_type: "user", actor_id: who.id, request_source: "api" },
        ),
      ).rejects.toMatchObject(LOCKED);
    }
    expect(await getToolPolicies(ctx.testDb.db, ctx.tenant_id, conversation_id)).toEqual({});
  }, 60_000);

  test("direct tools are refused: for another member as forbidden, for the owner as unavailable", async () => {
    const conversation_id = await runConversation();
    const call = (who: ResolvedPrincipal) =>
      invokeConversationToolDirect({
        db: ctx.testDb.db,
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: who.id,
        principal: who,
        tool: "validate_draft",
        args: {},
      });
    await expect(call(stranger)).rejects.toMatchObject(FORBIDDEN);
    const refused = await call(owner).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DirectInvokeError);
    expect((refused as DirectInvokeError).error_code).toBe("tool_not_available_in_task_run");
  }, 60_000);

  test("a fork is an ordinary conversation without the marker or a requested check", async () => {
    const conversation_id = await runConversation();
    await driveTurn(ctx, conversation_id, owner, [
      { tool: "schedule_task_check", args: { in_minutes: 45, reason: "wait for the export" } },
    ]);
    const [anchor] = await ctx.testDb.db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, ctx.tenant_id),
          eq(conversationMessages.conversation_id, conversation_id),
        ),
      )
      .limit(1);
    if (!anchor) throw new Error("expected a message to fork from");
    const forked = await svc.forkConversation(
      {
        tenant_id: ctx.tenant_id,
        source_conversation_id: conversation_id,
        anchor_message_id: anchor.id,
        actor_id: stranger.id,
        actor_type: "user",
        request_source: "api",
      },
      ctx.testDb.db,
    );
    if (!forked) throw new Error("fork failed");
    expect(await storedMarker(ctx, forked.conversation.id)).toBeNull();
    const [row] = await ctx.testDb.db
      .select({ draft: conversations.draft })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenant_id, ctx.tenant_id),
          eq(conversations.id, forked.conversation.id),
        ),
      );
    expect(getTaskRunCheck(row?.draft)).toBeNull();
    const outcome = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: forked.conversation.id,
        actor_id: stranger.id,
        principal: stranger,
        message: "Hello.",
      },
      ctx.testDb.db,
    );
    expect(outcome.result.status).toBe("active");
  }, 120_000);

  test("an ordinary conversation keeps accepting every one of these writes from its owner", async () => {
    const conversation_id = await createRunConversation(ctx, owner.id, null);
    await svc.appendUserMessage(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: owner.id,
        principal: owner,
        message: "Hello.",
      },
      ctx.testDb.db,
    );
    await svc.compactConversation(
      { tenant_id: ctx.tenant_id, conversation_id, actor_id: owner.id, principal: owner },
      ctx.testDb.db,
    );
    await svc.undoLastDraftMutation(ctx.tenant_id, conversation_id, ctx.testDb.db);
    await svc.patchConversation(
      { tenant_id: ctx.tenant_id, conversation_id, actor_id: owner.id, title: "Shared" },
      ctx.testDb.db,
    );
    await setToolPolicies(
      ctx.testDb.db,
      ctx.tenant_id,
      conversation_id,
      { run_workflow: "confirm_before_execution" },
      { actor_type: "user", actor_id: owner.id, request_source: "api" },
    );
    expect(await getToolPolicies(ctx.testDb.db, ctx.tenant_id, conversation_id)).toEqual({
      run_workflow: "confirm_before_execution",
    });
    expect(await userMessages(conversation_id)).toBe(1);
    await expect(
      svc.appendUserMessage(
        {
          tenant_id: ctx.tenant_id,
          conversation_id,
          actor_id: stranger.id,
          principal: stranger,
          message: "Hello.",
        },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await userMessages(conversation_id)).toBe(1);
  }, 120_000);
});
