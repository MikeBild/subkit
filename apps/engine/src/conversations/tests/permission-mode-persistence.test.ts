import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { getStoredPermissionMode } from "../service/shared.ts";
import { createConversation, getConversation } from "../service.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
  respondElicitationForTest,
} from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("permission_mode_persistence");
});

afterAll(async () => {
  await ctx?.cleanup();
});

describe("conversation permission mode persistence", () => {
  test("new sessions persist auto by default without changing stored or explicit modes", async () => {
    for (const mode of [undefined, "ask", "plan", "auto"] as const) {
      const created = await createConversation(
        {
          tenant_id: ctx.tenant_id,
          actor_id: ctx.user_id,
          ...(mode ? { permission_mode: mode } : {}),
        },
        ctx.testDb.db,
      );
      const detail = await getConversation(ctx.tenant_id, created.conversation.id, ctx.testDb.db);
      expect(detail?.draft?.session?.permission_mode).toBe(mode ?? "auto");
    }
    expect(getStoredPermissionMode(null)).toBeNull();
    expect(getStoredPermissionMode(undefined)).toBeNull();
  });
  test("the persisted default survives a destructive gate and resumes autonomous preparation", async () => {
    const created = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
      },
      ctx.testDb.db,
    );
    expect(created.result.status).toBe("active");

    getMockProvider().setConversePlan(created.conversation.id, [
      {
        tool: "ask_user_confirm",
        args: {
          question: "Really wipe the draft?",
          kind: "generic",
          summary: "Really wipe the draft?",
          destructive: true,
        },
      },
      {
        tool: "ask_user_confirm",
        args: {
          question: "Continue with the safe follow-up step?",
          kind: "generic",
          summary: "Continue with the safe follow-up step",
        },
      },
    ]);

    const firstTurn = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: created.conversation.id,
        actor_id: ctx.user_id,
        message: "continue",
      },
      ctx.testDb.db,
    );

    expect(firstTurn.result.status).toBe("awaiting_input");
    expect(firstTurn.result.pending_elicitation_id).toBeTruthy();

    const resumed = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: created.conversation.id,
        elicitation_id: firstTurn.result.pending_elicitation_id!,
        actor_id: ctx.user_id,
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );

    expect(resumed.result.status).toBe("active");
    expect(resumed.result.pending_elicitation_id).toBeUndefined();

    const detail = await getConversation(ctx.tenant_id, created.conversation.id, ctx.testDb.db);
    expect(detail?.draft?.session?.permission_mode).toBe("auto");
  });
});
