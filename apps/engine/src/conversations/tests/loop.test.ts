// End-to-end loop test:
//
//   1. User asks to "list users from the api"
//   2. Loop runs list_skills → fetch_connector_docs → edit_workflow_patch
//      (assembles the whole draft in one editor call)
//   3. inspect_workflow_draft + validate_draft confirm clean
//   4. dry_run_step previews a transform
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

    // Expected tool call sequence: the whole draft is assembled in one
    //   edit_workflow_patch call, then inspected/validated/previewed.
    expect(toolCallEvents.map((e) => e.tool)).toEqual([
      "list_skills",
      "fetch_connector_docs",
      "edit_workflow_patch",
      "inspect_workflow_draft",
      "validate_draft",
      "dry_run_step",
      "ask_user_confirm",
    ]);

    // The edit_workflow_patch call succeeded and produced a draft.
    const editResult = toolResultEvents.find((e) => e.tool === "edit_workflow_patch");
    expect(editResult).toBeDefined();

    // A snapshot should exist from the successful edit_workflow_patch.
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

    expect(resumed.result.status).toBe("active");
    expect(resumed.result.committed_workflow_id).toBeDefined();

    // There should be a brand-new workflow row for the tenant.
    const wfRows = await ctx.testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.tenant_id, ctx.tenant_id));
    expect(wfRows.length).toBe(1);
    expect(wfRows[0]?.id).toBe(resumed.result.committed_workflow_id);
    expect(wfRows[0]?.current_version_id).toBeNull();
    expect(wfRows[0]?.draft_version_id).toBeTruthy();

    // Saving an inert draft keeps the authoring conversation active.
    const detail = await getConversation(ctx.tenant_id, outcome.conversation.id, ctx.testDb.db);
    expect(detail?.conversation.status).toBe("active");
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
