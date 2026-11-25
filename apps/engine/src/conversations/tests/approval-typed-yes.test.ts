import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversationElicitations, conversationToolCalls } from "../../db/schema/index.ts";
import { getConversation } from "../service/index.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
  respondElicitationForTest,
} from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("approval-typed-yes");
});

afterAll(async () => {
  await ctx.cleanup();
});

test("a typed yes keeps the open save card when the next turn asks for the same save", async () => {
  const outcome = await createConversationWithTurn(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      connector_id: ctx.connector_id,
      initial_message: "list users",
      ask_before_writing: true,
    },
    ctx.testDb.db,
  );
  const elicitationId = outcome.result.pending_elicitation_id;
  if (!elicitationId) throw new Error("no elicitation id");

  const next = await appendMessageWithTurn(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: outcome.conversation.id,
      actor_id: ctx.user_id,
      message: "yes",
      ask_before_writing: true,
    },
    ctx.testDb.db,
  );

  const rows = await ctx.testDb.db
    .select()
    .from(conversationElicitations)
    .where(eq(conversationElicitations.conversation_id, outcome.conversation.id));
  const original = rows.find((row) => row.id === elicitationId);
  expect(original?.status).toBe("pending");
  expect(original?.output).toBeNull();
  expect(rows.filter((row) => row.status === "pending").map((row) => row.id)).toEqual([
    elicitationId,
  ]);
  expect(rows.some((row) => row.decision_reason === "superseded_by_new_elicitation")).toBe(false);
  const toolCalls = await ctx.testDb.db
    .select()
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.conversation_id, outcome.conversation.id));
  const gatedSave = toolCalls.find((row) => row.tool === "save_workflow_draft");
  expect(gatedSave?.output).toMatchObject({ pending: true, elicitation_id: elicitationId });
  expect(next.conversation.status).toBe("awaiting_input");
  const detail = await getConversation(ctx.tenant_id, outcome.conversation.id, ctx.testDb.db);
  expect(detail?.conversation.target_workflow_id).toBeNull();

  const approved = await respondElicitationForTest(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: outcome.conversation.id,
      elicitation_id: elicitationId,
      actor_id: ctx.user_id,
      ask_before_writing: true,
      output: { confirmed: true },
    },
    ctx.testDb.db,
  );
  expect(approved.result.pending_elicitation_id).toBeUndefined();
  const decided = await ctx.testDb.db
    .select()
    .from(conversationElicitations)
    .where(eq(conversationElicitations.conversation_id, outcome.conversation.id));
  expect(decided.map((row) => [row.id, row.status, row.output])).toEqual([
    [elicitationId, "resolved", { confirmed: true }],
  ]);
});
