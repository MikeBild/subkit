import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversationDrafts, workflows } from "../../db/schema/index.ts";
import {
  getMetrics,
  METRIC_NAMES,
  resetMetricsRegistryForTests,
} from "../../observability/metrics.ts";
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
  ctx = await createConversationTestCtx("loop");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("conversations/loop", () => {
  test("drives the full list-users tool trace with validation feedback, approval, commit", async () => {
    resetMetricsRegistryForTests();
    const outcome = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        connector_id: ctx.connector_id,
        initial_message: "please list users from the api",
        ask_before_writing: true,
      },
      ctx.testDb.db,
    );

    expect(outcome.result.status).toBe("awaiting_input");
    expect(outcome.result.pending_elicitation_id).toBeDefined();

    const toolCallEvents = outcome.result.events.filter(
      (e) => e.type === "tool_call_start",
    ) as Array<{ tool: string }>;
    const toolResultEvents = outcome.result.events.filter(
      (e) => e.type === "tool_result",
    ) as Array<{ tool: string; output: unknown }>;

    expect(toolCallEvents.map((e) => e.tool)).toEqual([
      "list_skills",
      "fetch_connector_docs",
      "edit_workflow_patch",
      "inspect_workflow_draft",
      "validate_draft",
      "dry_run_step",
      "ask_user_confirm",
    ]);

    const editResult = toolResultEvents.find((e) => e.tool === "edit_workflow_patch");
    expect(editResult).toBeDefined();

    expect(getMetrics().counterSum(METRIC_NAMES.CONVERSATION_STEP_TOTAL)).toBe(
      toolCallEvents.length,
    );
    const durationCounts = (
      getMetrics()
        .snapshot()
        .find((s) => s.name === METRIC_NAMES.CONVERSATION_TOOL_DURATION_MS)?.samples ?? []
    ).filter((s) => s.name === `${METRIC_NAMES.CONVERSATION_TOOL_DURATION_MS}_count`);
    for (const tool of toolCallEvents.map((e) => e.tool).filter((t) => t !== "ask_user_confirm")) {
      const observed = durationCounts.filter((s) => s.labels.tool === tool);
      expect(observed.reduce((sum, s) => sum + s.value, 0)).toBe(1);
      expect(observed.every((s) => s.labels.outcome !== "")).toBe(true);
    }

    const snapshots = await ctx.testDb.db
      .select()
      .from(conversationDrafts)
      .where(eq(conversationDrafts.conversation_id, outcome.conversation.id));
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    const elicitationId = outcome.result.pending_elicitation_id;
    if (!elicitationId) throw new Error("expected pending_elicitation_id");
    const resumed = await respondElicitationForTest(
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

    expect(resumed.result.status).toBe("active");
    expect(resumed.result.committed_workflow_id).toBeDefined();

    const wfRows = await ctx.testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.tenant_id, ctx.tenant_id));
    expect(wfRows.length).toBe(1);
    expect(wfRows[0]?.id).toBe(resumed.result.committed_workflow_id);
    expect(wfRows[0]?.current_version_id).toBeNull();
    expect(wfRows[0]?.draft_version_id).toBeTruthy();

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
    const toolCalls = outcome.result.events.filter((e) => e.type === "tool_call_start");
    expect(toolCalls.length).toBe(0);
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
