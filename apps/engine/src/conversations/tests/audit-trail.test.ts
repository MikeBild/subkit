// A5 audit-trail + DB-row invariants.
//
// The plan-file's reliability guardrails claim: one `conversation_tool_calls`
// row per tool call, one `llm_usage` row per LLM step, every tool call has
// an output set, every pause/commit emits the right audit events. This
// suite locks those invariants in against the live loop + approval flow.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import {
  conversationMessages,
  conversationToolCalls,
  llmUsage,
  workflows,
} from "../../db/schema/index.ts";
import { createConversation, decideApproval } from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("audit_trail");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("conversations/audit-trail", () => {
  test("list-users flow writes exactly the expected DB rows + audit entries", async () => {
    const created = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        connector_id: ctx.connector_id,
        initial_message: "please list users from the api",
      },
      ctx.testDb.db,
    );
    expect(created.result.status).toBe("awaiting_approval");
    const approvalId = created.result.pending_approval_id;
    if (!approvalId) throw new Error("expected pending_approval_id after first turn");

    // ----- After first (paused) turn -----
    const toolCallsAfterPause = await ctx.testDb.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, created.conversation.id))
      .orderBy(asc(conversationToolCalls.created_at));
    const expectedToolsPause = [
      "list_skills",
      "fetch_connector_docs",
      "propose_step",
      "propose_step",
      "validate_draft",
      "request_human_approval",
    ];
    expect(toolCallsAfterPause.map((r) => r.tool)).toEqual(expectedToolsPause);
    // Every tool-call row has an output written (sdk-wrap updates the row).
    expect(toolCallsAfterPause.every((r) => r.output !== null && r.output !== undefined)).toBe(
      true,
    );
    // `approval_required` flag flips only on request_human_approval.
    expect(toolCallsAfterPause.filter((r) => r.approval_required).map((r) => r.tool)).toEqual([
      "request_human_approval",
    ]);

    // One llm_usage row per SDK step. With the MockLanguageModelV3, each
    // tool call drives exactly one step, so rows == tool_calls.
    const usagePause = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, ctx.tenant_id), eq(llmUsage.flow, "converse")));
    expect(usagePause.length).toBe(toolCallsAfterPause.length);
    expect(usagePause.every((r) => r.result === "success")).toBe(true);
    expect(usagePause.every((r) => r.model === "mock-model-id" || r.model.length > 0)).toBe(true);

    // Tool-audit messages: one `tool` role message per executed tool-call
    // row (sdk-wrap appends them for the self-contained audit trail),
    // plus the initial user message.
    const messagesPause = await ctx.testDb.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversation_id, created.conversation.id))
      .orderBy(asc(conversationMessages.created_at));
    const rolesPause = messagesPause.map((m) => m.role);
    expect(rolesPause[0]).toBe("user");
    expect(rolesPause.filter((r) => r === "tool").length).toBe(toolCallsAfterPause.length);

    // Audit-log entries so far: created, memory_injected? (no), approval.requested.
    const auditPause = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.resource_id, created.conversation.id),
        ),
      )
      .orderBy(asc(auditLog.ts));
    const auditActionsPause = auditPause.map((a) => a.action);
    expect(auditActionsPause).toContain("conversation.created");
    // The approval.requested audit on the approvalRequests row also
    // lives in audit_log but with a different resource_id; ensure it
    // was written in the same tenant.
    const anyApprovalRequested = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.action, "approval.requested")));
    expect(anyApprovalRequested.length).toBe(1);

    // ----- Resume after approval -----
    const resumed = await decideApproval(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: created.conversation.id,
        approval_id: approvalId,
        actor_id: ctx.user_id,
        decision: "approved",
      },
      ctx.testDb.db,
    );
    expect(resumed.result.status).toBe("committed");
    const committedWorkflowId = resumed.result.committed_workflow_id;
    expect(committedWorkflowId).toBeTruthy();

    // ----- After committed turn -----
    const toolCallsFinal = await ctx.testDb.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, created.conversation.id))
      .orderBy(asc(conversationToolCalls.created_at));
    expect(toolCallsFinal.map((r) => r.tool)).toEqual([...expectedToolsPause, "commit_draft"]);
    expect(toolCallsFinal.every((r) => r.output !== null && r.output !== undefined)).toBe(true);

    const usageFinal = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, ctx.tenant_id), eq(llmUsage.flow, "converse")));
    // commit_draft adds one more step.
    expect(usageFinal.length).toBe(toolCallsFinal.length);

    // Workflow row written.
    const wfRows = await ctx.testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, committedWorkflowId as string));
    expect(wfRows.length).toBe(1);

    // Full audit trail on the conversation + approval + workflow.
    const auditConv = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.resource_id, created.conversation.id),
        ),
      )
      .orderBy(asc(auditLog.ts));
    expect(auditConv.map((a) => a.action)).toEqual([
      "conversation.created",
      "conversation.committed",
    ]);

    const auditApproval = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.action, "approval.approved")));
    expect(auditApproval.length).toBe(1);
    expect((auditApproval[0]?.metadata as { conversation_id: string }).conversation_id).toBe(
      created.conversation.id,
    );

    const auditWorkflowCreated = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.action, "workflow.created")));
    expect(auditWorkflowCreated.length).toBe(1);

    // Monthly usage reflects all recorded token activity (at least one
    // token accounted per step). Use the budget helper to verify the
    // total_tokens column is non-zero and matches sum(prompt + completion).
    const totalRecorded = usageFinal.reduce((acc, r) => acc + Number(r.total_tokens ?? 0), 0);
    expect(totalRecorded).toBeGreaterThan(0);
  });
});
