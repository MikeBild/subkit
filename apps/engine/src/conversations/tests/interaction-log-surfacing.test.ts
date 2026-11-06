import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import { assembleEnhancedPrompt } from "../../llm/runtime/context-assembler.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("interaction-log-surfacing");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function makeConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({
      tenant_id: ctx.tenant_id,
      status: "active",
      owner_id: ctx.user_id,
    })
    .returning();
  if (!row) throw new Error("seed conversation failed");
  return row.id;
}

interface SeedElicitation {
  tool_name: string;
  status: "pending" | "resolved" | "cancelled" | "timeout";
  output?: Record<string, unknown> | null;
  decision_reason?: string;
}

async function seedElicitation(conversationId: string, e: SeedElicitation): Promise<void> {
  await ctx.testDb.db.insert(conversationElicitations).values({
    tenant_id: ctx.tenant_id,
    conversation_id: conversationId,
    tool_name: e.tool_name,
    summary: `${e.tool_name} test`,
    input: { kind: "test" },
    output: e.output ?? null,
    status: e.status,
    ...(e.decision_reason ? { decision_reason: e.decision_reason } : {}),
  });
}

async function assemble(conversationId: string): Promise<string> {
  const prompt = await assembleEnhancedPrompt(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: conversationId,
      flow: "converse",
      user_turns: [{ role: "user", content: "hello" }],
      max_tokens: 180_000,
      model: "claude-sonnet-4-6",
    },
    ctx.testDb.db,
  );
  return prompt.system;
}

describe("interaction log · surfacing", () => {
  test("section appears with approved/declined/partial decisions", async () => {
    const cid = await makeConversation();
    await seedElicitation(cid, {
      tool_name: "ask_user_confirm",
      status: "resolved",
      output: { confirmed: true },
    });
    await seedElicitation(cid, {
      tool_name: "ask_user_confirm",
      status: "resolved",
      output: { confirmed: false, feedback: "the budget is wrong, fix the totals first" },
      decision_reason: "user_declined",
    });
    await seedElicitation(cid, {
      tool_name: "ask_user_text",
      status: "cancelled",
      output: null,
      decision_reason: "user_cancelled",
    });
    await seedElicitation(cid, {
      tool_name: "ask_user_form",
      status: "resolved",
      output: { confirmed: true, approved_indices: [0, 2] },
    });

    const system = await assemble(cid);
    expect(system).toContain("Append-only record of the recent confirmations");
    expect(system).toContain("ask_user_confirm");
    expect(system).toContain("ask_user_form");
    expect(system).toContain("approved");
    expect(system).toContain("declined");
    expect(system).toContain("partial");
    expect(system).toContain("the budget is wrong, fix the totals first");
    expect(system).not.toContain("user_declined");
    expect(system).toContain("user_cancelled");
  });

  test("pending elicitations are excluded — only resolved ones surface", async () => {
    const cid = await makeConversation();
    await seedElicitation(cid, {
      tool_name: "ask_user_text",
      status: "pending",
    });
    const system = await assemble(cid);
    expect(system).not.toContain("Append-only record of the recent confirmations");
  });

  test("conversation with no elicitations omits the section entirely", async () => {
    const cid = await makeConversation();
    const system = await assemble(cid);
    expect(system).not.toContain("Append-only record of the recent confirmations");
  });

  test("section is omitted when conversation_id is not threaded through", async () => {
    const cid = await makeConversation();
    await seedElicitation(cid, {
      tool_name: "ask_user_confirm",
      status: "resolved",
      output: { confirmed: true },
    });
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "hello" }],
        max_tokens: 180_000,
        model: "claude-sonnet-4-6",
      },
      ctx.testDb.db,
    );
    expect(prompt.system).not.toContain("Append-only record of the recent confirmations");
  });
});
