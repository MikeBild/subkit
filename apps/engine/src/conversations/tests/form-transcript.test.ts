import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getConversation } from "../service/get.ts";

let ctx: TestDb;
let tenant_id: string;
beforeAll(async () => {
  ctx = await createTestDb("form_transcript");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "form-transcript", display_name: "Forms" })
    .returning();
  tenant_id = tenant!.id;
});
afterAll(async () => {
  await ctx.cleanup();
});

for (const example of [
  {
    tool: "ask_user_form",
    status: "resolved",
    output: { values: { secret: "never-copy-answer" } },
    expected: "resolved",
    outcome: "ok",
  },
  {
    tool: "ask_user_form",
    status: "resolved",
    output: { declined: true },
    expected: "cancelled",
    outcome: "denied",
  },
  {
    tool: "ask_user_form",
    status: "timeout",
    output: null,
    expected: "timeout",
    outcome: "denied",
  },
  {
    tool: "run_workflow",
    status: "resolved",
    output: { declined: true },
    expected: "cancelled",
    outcome: "denied",
  },
] as const) {
  test(`canonical form ending ${example.tool}/${example.expected} survives detail reload`, async () => {
    const [conversation] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning();
    const [call] = await ctx.db
      .insert(conversationToolCalls)
      .values({
        tenant_id,
        conversation_id: conversation!.id,
        tool: example.tool,
        input: {},
        output: { status: "awaiting_input" },
        outcome: "pending",
      })
      .returning();
    await ctx.db.insert(conversationElicitations).values({
      tenant_id,
      conversation_id: conversation!.id,
      tool_call_id: call!.id,
      tool_name: "ask_user_form",
      summary: "Details",
      input: {},
      status: example.status,
      output: example.output,
    });
    const detail = await getConversation(tenant_id, conversation!.id, ctx.db);
    expect(detail!.tool_calls[0]!.output).toMatchObject({ status: example.expected });
    expect(detail!.tool_calls[0]!.outcome).toBe(example.outcome);
    expect(JSON.stringify(detail!.tool_calls)).not.toContain("never-copy-answer");
  });
}
