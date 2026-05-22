// End-to-end loop test:
//
//   1. User asks to "list users from the api"
//   2. Loop runs list_skills → fetch_connector_docs → propose_step
//      (first attempt fails validation because url + connector_id
//      are both missing)
//   3. Loop self-corrects with a second propose_step carrying a real
//      url → passes
//   4. validate_draft confirms clean
//   5. ask_user_confirm pauses the loop
//   6. User answers { confirmed: true } → loop resumes → save_workflow_draft
//      → new workflow

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversationDrafts, workflows } from "../../db/schema/index.ts";
import { getConversation } from "../service.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
  respondElicitationForTest,
} from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("loop");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("conversations/loop", () => {
  test("drives the full list-users tool trace with validation feedback, approval, commit", async () => {
    const outcome = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        connector_id: ctx.connector_id,
        initial_message: "please list users from the api",
      },
      ctx.testDb.db,
    );

    // The first run stops at the ask_user_confirm pause.
    expect(outcome.result.status).toBe("awaiting_input");
    expect(outcome.result.pending_elicitation_id).toBeDefined();

    // Walk through the recorded events and make sure the expected
    // trace is there.
    const toolCallEvents = outcome.result.events.filter(
      (e) => e.type === "tool_call_start",
    ) as Array<{ tool: string }>;
    const toolResultEvents = outcome.result.events.filter(
      (e) => e.type === "tool_result",
    ) as Array<{ tool: string; output: unknown }>;
    const validationErrors = outcome.result.events.filter((e) => e.type === "validation_error");

    // Expected tool call sequence:
    //   list_skills, fetch_connector_docs, propose_step (fail),
    //   propose_step (fix request), propose_step (add previewable transform),
    //   inspect_workflow_draft, validate_draft, dry_run_step, ask_user_confirm
    expect(toolCallEvents.map((e) => e.tool)).toEqual([
      "list_skills",
      "fetch_connector_docs",
      "propose_step",
      "propose_step",
      "propose_step",
      "inspect_workflow_draft",
      "validate_draft",
      "dry_run_step",
      "ask_user_confirm",
    ]);

    // First propose_step must have fed a validation error back.
    expect(validationErrors.length).toBeGreaterThanOrEqual(1);
    const firstProposeResult = toolResultEvents.find((e) => e.tool === "propose_step");
    expect(firstProposeResult).toBeDefined();
    expect((firstProposeResult as { output: { errors?: unknown[] } }).output.errors).toBeTruthy();

    // A snapshot should exist from the successful second propose.
    const snapshots = await ctx.testDb.db
      .select()
      .from(conversationDrafts)
      .where(eq(conversationDrafts.conversation_id, outcome.conversation.id));
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    // Now confirm and resume — the plan continues with save_workflow_draft.
    const elicitationId = outcome.result.pending_elicitation_id;
    if (!elicitationId) throw new Error("expected pending_elicitation_id");
    const resumed = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: outcome.conversation.id,
        elicitation_id: elicitationId,
        actor_id: ctx.user_id,
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );

    expect(resumed.result.status).toBe("committed");
    expect(resumed.result.committed_workflow_id).toBeDefined();

    // There should be a brand-new workflow row for the tenant.
    const wfRows = await ctx.testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.tenant_id, ctx.tenant_id));
    expect(wfRows.length).toBe(1);
    expect(wfRows[0]?.id).toBe(resumed.result.committed_workflow_id);

    // Final conversation record should be committed.
    const detail = await getConversation(ctx.tenant_id, outcome.conversation.id, ctx.testDb.db);
    expect(detail?.conversation.status).toBe("committed");
    expect(detail?.conversation.target_workflow_id).toBe(
      resumed.result.committed_workflow_id ?? "",
    );
  });

  test("unknown user message simply ends the turn cleanly", async () => {
    const outcome = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        initial_message: "hello",
      },
      ctx.testDb.db,
    );
    // No canned plan matched — the run should end with no tool calls.
    const toolCalls = outcome.result.events.filter((e) => e.type === "tool_call_start");
    expect(toolCalls.length).toBe(0);
    // Appending another message still works and is a no-op.
    const cont = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: outcome.conversation.id,
        actor_id: ctx.user_id,
        message: "ping",
      },
      ctx.testDb.db,
    );
    expect(cont.result.status).toBeTruthy();
  });
});
