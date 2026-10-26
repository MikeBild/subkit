import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import {
  conversationMessages,
  conversationToolCalls,
  llmUsage,
  workflows,
} from "../../db/schema/index.ts";
import { createSystemAccount } from "../../identity/service.ts";
import { answeringModelLabel } from "../loop/model-resolver.ts";
import { createConversation } from "../service.ts";
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
  test("creation audit uses the authenticated principal and keeps missing principals unknown", async () => {
    const account = await createSystemAccount(
      { tenant_id: ctx.tenant_id, name: "conversation-actor", actor_id: ctx.user_id },
      ctx.testDb.db,
    );
    const typed = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        principal: {
          provider: "test",
          kind: "system_account",
          id: account.id,
          tenant_id: ctx.tenant_id,
          roles: [],
        },
      },
      ctx.testDb.db,
    );
    const unknown = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id },
      ctx.testDb.db,
    );
    const rows = await ctx.testDb.db
      .select({
        resource_id: auditLog.resource_id,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
      })
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.action, "conversation.created")),
      );
    expect(rows.find((row) => row.resource_id === typed.conversation.id)).toEqual({
      resource_id: typed.conversation.id,
      actor_type: "system_account",
      actor_id: account.id,
    });
    expect(rows.find((row) => row.resource_id === unknown.conversation.id)).toEqual({
      resource_id: unknown.conversation.id,
      actor_type: "unknown",
      actor_id: null,
    });
  });

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
    expect(toolCallsAfterPause.every((r) => r.output !== null && r.output !== undefined)).toBe(
      true,
    );
    expect(toolCallsAfterPause.filter((r) => r.approval_required).map((r) => r.tool)).toEqual([
      "ask_user_confirm",
    ]);

    const usagePause = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, ctx.tenant_id), eq(llmUsage.flow, "converse")));
    expect(usagePause.length).toBe(toolCallsAfterPause.length);
    expect(usagePause.every((r) => r.result === "success")).toBe(true);
    expect(usagePause.every((r) => r.model === "mock-model-id" || r.model.length > 0)).toBe(true);

    const messagesPause = await ctx.testDb.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversation_id, created.conversation.id))
      .orderBy(asc(conversationMessages.created_at));
    const rolesPause = messagesPause.map((m) => m.role);
    expect(rolesPause[0]).toBe("user");
    expect(rolesPause.filter((r) => r === "tool").length).toBe(toolCallsAfterPause.length);
    const engineAuthored = (message: (typeof messagesPause)[number]) =>
      (message.content as { _synthetic?: boolean } | null)?._synthetic === true;
    const assistantMessages = messagesPause.filter(
      (message) => message.role === "assistant" && !engineAuthored(message),
    );
    expect(assistantMessages.length).toBeGreaterThan(0);
    expect(
      messagesPause
        .filter((message) => message.role === "assistant" && engineAuthored(message))
        .map((message) => (message.content as { _reason?: string })._reason),
    ).toEqual(["handoff_summary"]);
    const billedModels = new Set(
      usagePause.map((usage) => answeringModelLabel("mock", usage.model)),
    );
    expect(
      assistantMessages.every(
        (message) => message.model !== null && billedModels.has(message.model),
      ),
    ).toBe(true);

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
    const anyApprovalRequested = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.action, "approval.requested")));
    expect(anyApprovalRequested.length).toBe(1);

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
    expect(usageFinal.length).toBe(toolCallsFinal.length - 1);

    const wfRows = await ctx.testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, committedWorkflowId as string));
    expect(wfRows.length).toBe(1);
    expect(wfRows[0]!.current_version_id).toBeNull();
    expect(wfRows[0]!.draft_version_id).toBeTruthy();

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
    const lifecycleActions = auditConv
      .map((a) => a.action)
      .filter((a) => a !== "tool_policy.confirmation_required");
    expect(lifecycleActions).toEqual(["conversation.created"]);

    const auditApproval = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.action, "approval.approved")));
    const userApprovals = auditApproval.filter((a) => a.reason === null);
    expect(userApprovals.length).toBe(1);
    expect((userApprovals[0]!.metadata as { conversation_id: string }).conversation_id).toBe(
      created.conversation.id,
    );

    const auditWorkflowCreated = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, "workflow.created"),
          eq(auditLog.resource_id, committedWorkflowId as string),
        ),
      );
    expect(auditWorkflowCreated).toHaveLength(1);
    expect(auditWorkflowCreated[0]!.reason).toBe("auto_persist_on_confirmation");
    expect(auditWorkflowCreated[0]!.metadata).toMatchObject({
      kind: "draft",
      source: "harness_auto_persist",
      commit_intent_kind: "save_workflow_draft",
    });

    const totalRecorded = usageFinal.reduce((acc, r) => acc + Number(r.total_tokens ?? 0), 0);
    expect(totalRecorded).toBeGreaterThan(0);
  });
});
