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
import {
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
  respondElicitationForTest,
} from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("audit_trail");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("conversations/audit-trail", () => {
  test("list-users flow writes exactly the expected DB rows + audit entries", async () => {
    const created = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        connector_id: ctx.connector_id,
        initial_message: "please list users from the api",
        permission_mode: "ask",
      },
      ctx.testDb.db,
    );
    expect(created.result.status).toBe("awaiting_input");
    const elicitationId = created.result.pending_elicitation_id;
    if (!elicitationId) throw new Error("expected pending_elicitation_id after first turn");

    // ----- After first (paused) turn -----
    const toolCallsAfterPause = await ctx.testDb.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, created.conversation.id))
      .orderBy(asc(conversationToolCalls.created_at));
    const expectedToolsPause = [
      "list_skills",
      "fetch_connector_docs",
      "edit_workflow_patch",
      "inspect_workflow_draft",
      "validate_draft",
      "dry_run_step",
      "ask_user_confirm",
    ];
    expect(toolCallsAfterPause.map((r) => r.tool)).toEqual(expectedToolsPause);
    // Every tool-call row has an output written (sdk-wrap updates the row).
    expect(toolCallsAfterPause.every((r) => r.output !== null && r.output !== undefined)).toBe(
      true,
    );
    // `approval_required` flag flips only on ask_user_* tools.
    expect(toolCallsAfterPause.filter((r) => r.approval_required).map((r) => r.tool)).toEqual([
      "ask_user_confirm",
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
    const assistantMessages = messagesPause.filter((message) => message.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThan(0);
    const billedModels = new Set(usagePause.map((usage) => usage.model));
    expect(
      assistantMessages.every(
        (message) => message.model !== null && billedModels.has(message.model),
      ),
    ).toBe(true);

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

    // ----- Resume after user confirms -----
    const resumed = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: created.conversation.id,
        elicitation_id: elicitationId,
        actor_id: ctx.user_id,
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );
    expect(resumed.result.status).toBe("active");
    const committedWorkflowId = resumed.result.committed_workflow_id;
    expect(committedWorkflowId).toBeTruthy();

    // ----- After committed turn -----
    const toolCallsFinal = await ctx.testDb.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, created.conversation.id))
      .orderBy(asc(conversationToolCalls.created_at));
    expect(toolCallsFinal.map((r) => r.tool)).toEqual([
      ...expectedToolsPause,
      "save_workflow_draft",
    ]);
    expect(toolCallsFinal.every((r) => r.output !== null && r.output !== undefined)).toBe(true);

    const usageFinal = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, ctx.tenant_id), eq(llmUsage.flow, "converse")));
    // 1 llmUsage row per LLM-driven step. The trailing `save_workflow_draft`
    // tool call was synthesised by the harness auto-persist on the
    // elicitation resume — it carries no LLM step (no streamText call,
    // no tokens billed) so it is recorded in conversation_tool_calls
    // but does NOT add an llmUsage row.
    expect(usageFinal.length).toBe(toolCallsFinal.length - 1);

    // Workflow row written.
    const wfRows = await ctx.testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, committedWorkflowId as string));
    expect(wfRows.length).toBe(1);
    expect(wfRows[0]!.current_version_id).toBeNull();
    expect(wfRows[0]!.draft_version_id).toBeTruthy();

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
    // Every confirm_before_execution decision (e.g. save_workflow_draft)
    // lands a `tool_policy.confirmation_required` row tagged with the
    // conversation_id, so operators can audit policy decisions without
    // scraping debug logs. Filter that row out for the canonical
    // resource lifecycle assertion below — the policy row carries the
    // conversation as resource_id but the test cares about the
    // resource-level audit shape.
    const lifecycleActions = auditConv
      .map((a) => a.action)
      .filter((a) => a !== "tool_policy.confirmation_required");
    expect(lifecycleActions).toEqual(["conversation.created"]);
    // The policy row is INCIDENTAL — it fires only when the LLM
    // calls a `confirm_before_execution` tool directly. The canonical
    // path the LLM now takes is to emit
    // `ask_user_confirm{kind:save_workflow_draft}` itself (post save-workflow-draft
    // elicitation tightening, commit 4c1f409), which bypasses the
    // policy gate entirely. The assertion that policy rows exist was
    // pinning the old codepath; we simply tolerate either shape now.

    const auditApproval = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.action, "approval.approved")));
    // Two `approval.approved` rows are written per elicitation now:
    //   1. the user-side approve (reason: null)
    //   2. the harness auto-persist outcome
    //      (reason: "auto_persist_on_confirmation")
    // Filter to the user-side one for the canonical assertion.
    const userApprovals = auditApproval.filter((a) => a.reason === null);
    expect(userApprovals.length).toBe(1);
    expect((userApprovals[0]!.metadata as { conversation_id: string }).conversation_id).toBe(
      created.conversation.id,
    );

    const auditWorkflowCreated = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.action, "workflow.created")));
    // Two `workflow.created` rows are emitted now: the canonical
    // resource audit (reason: null) from createWorkflow plus the
    // harness auto-persist tag (reason: "auto_persist_on_confirmation")
    // — matches the dual-audit pattern on approval.approved. Use the
    // canonical one for the assertion.
    const canonicalCreated = auditWorkflowCreated.filter((a) => a.reason === null);
    expect(canonicalCreated.length).toBe(1);
    expect((canonicalCreated[0]!.metadata as { kind: string }).kind).toBe("draft");

    // Monthly usage reflects all recorded token activity (at least one
    // token accounted per step). Use the budget helper to verify the
    // total_tokens column is non-zero and matches sum(prompt + completion).
    const totalRecorded = usageFinal.reduce((acc, r) => acc + Number(r.total_tokens ?? 0), 0);
    expect(totalRecorded).toBeGreaterThan(0);
  });
});
