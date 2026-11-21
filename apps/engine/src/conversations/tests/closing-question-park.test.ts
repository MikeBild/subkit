import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversationElicitations } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import type { ElicitationBridge } from "../elicitation-bridge.ts";
import { createConversation } from "../service/index.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
} from "./setup.ts";

let ctx: ConversationTestCtx;

const QUESTION = "Was möchtest du jetzt tun?";
const CLOSING = `Der Workflow ist vorbereitet.\n\n${QUESTION}`;

const bridge: ElicitationBridge = {
  capabilities: { form: true, oob: false },
  elicitForm: async () => ({ action: "cancel" }),
  elicitOob: async () => ({ action: "cancel" }),
};

beforeAll(async () => {
  ctx = await createConversationTestCtx("closing_question_park");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function turnEndingOnQuestion(
  turn: Pick<Parameters<typeof appendMessageWithTurn>[0], "surface" | "elicitationBridge">,
) {
  const created = await createConversation(
    { tenant_id: ctx.tenant_id, actor_id: ctx.user_id },
    ctx.testDb.db,
  );
  const conversationId = created.conversation.id;
  getMockProvider().setConversePlan(conversationId, [{ text: CLOSING }]);
  const outcome = await appendMessageWithTurn(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: conversationId,
      actor_id: ctx.user_id,
      message: "Bereite den Kundenbericht vor",
      ...turn,
    },
    ctx.testDb.db,
  );
  const parked = await ctx.testDb.db
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, ctx.tenant_id),
        eq(conversationElicitations.conversation_id, conversationId),
      ),
    );
  return { status: outcome.result.status, parked };
}

describe("a turn that ends on a prose question", () => {
  test("stays open for the next message when no surface is named", async () => {
    const { status, parked } = await turnEndingOnQuestion({});
    expect(status).toBe("active");
    expect(parked).toHaveLength(0);
  });

  test("stays open for the next message in the chat", async () => {
    const { status, parked } = await turnEndingOnQuestion({ surface: "chat" });
    expect(status).toBe("active");
    expect(parked).toHaveLength(0);
  });

  test("stays open over MCP when the client can be asked within the turn", async () => {
    const { status, parked } = await turnEndingOnQuestion({
      surface: "mcp",
      elicitationBridge: bridge,
    });
    expect(status).toBe("active");
    expect(parked).toHaveLength(0);
  });

  test("waits on a text question over MCP when nobody can be asked within the turn", async () => {
    const { status, parked } = await turnEndingOnQuestion({ surface: "mcp" });
    expect(status).toBe("awaiting_input");
    expect(parked).toHaveLength(1);
    expect(parked[0]?.tool_name).toBe("ask_user_text");
    expect(parked[0]?.input).toMatchObject({ question: QUESTION });
  });
});
