// Interaction log section — surfaces the last ~10 resolved
// elicitations so the model can see "what was tested vs. confirmed
// vs. declined this turn". Failure mode without this: the model
// re-asks for already-declined actions or treats partial approvals
// as full.
//
// Three layers verified:
//   1. The section appears at all when the conversation has resolved
//      elicitations.
//   2. Each entry includes the tool_name + decision (`approved` /
//      `declined` / `partial`) so the model can act on it.
//   3. Pending elicitations are NOT surfaced — only resolved ones —
//      because they're still waiting for the user.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import { assembleEnhancedPrompt } from "../../llm/core/context-assembler.ts";
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
      // Use Claude's default 180k cap so the interaction_log section
      // (lowest priority) doesn't get evicted by the budget trimmer.
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
    // Operator free text now rides on `output.feedback`; the
    // interaction-log formatter must surface that prose, not the
    // machine-code `decision_reason`.
    await seedElicitation(cid, {
      tool_name: "ask_user_confirm",
      status: "resolved",
      output: { confirmed: false, feedback: "the budget is wrong, fix the totals first" },
      decision_reason: "user_declined",
    });
    // Fallback case: no `output.feedback` — the formatter falls back to
    // the machine-code `decision_reason`.
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
    // Section is identified by its rendered-body marker (the
    // confirmation-discipline skill mentions the heading by name in
    // backticks; we look for the actual section's prose to avoid
    // false-positives).
    expect(system).toContain("Append-only record of the recent confirmations");
    // Tool names render verbatim so the model can match decisions to
    // upcoming tool calls.
    expect(system).toContain("ask_user_confirm");
    expect(system).toContain("ask_user_form");
    // Each decision string surfaces.
    expect(system).toContain("approved");
    expect(system).toContain("declined");
    expect(system).toContain("partial");
    // The operator's free-text `output.feedback` is surfaced verbatim —
    // the model sees the actual prose, not the machine code.
    expect(system).toContain("the budget is wrong, fix the totals first");
    // It is preferred OVER the machine-code `decision_reason` on that
    // same row — `user_declined` must not leak when feedback exists.
    expect(system).not.toContain("user_declined");
    // Fallback: a row with no `output.feedback` still surfaces its
    // machine-code `decision_reason`.
    expect(system).toContain("user_cancelled");
  });

  test("pending elicitations are excluded — only resolved ones surface", async () => {
    const cid = await makeConversation();
    await seedElicitation(cid, {
      tool_name: "ask_user_text",
      status: "pending",
    });
    const system = await assemble(cid);
    // Section should NOT appear for a conversation with only pending
    // elicitations — there's nothing decided yet.
    expect(system).not.toContain("Append-only record of the recent confirmations");
  });

  test("conversation with no elicitations omits the section entirely", async () => {
    const cid = await makeConversation();
    const system = await assemble(cid);
    expect(system).not.toContain("Append-only record of the recent confirmations");
  });

  test("section is omitted when conversation_id is not threaded through", async () => {
    // Even if elicitations exist for some other conversation, no
    // interaction_log surfaces unless the caller threads conversation_id.
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
