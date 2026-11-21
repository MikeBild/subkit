import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { conversationElicitations, workflows } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { appendSnapshot } from "../draft.ts";
import { commitWorkflowAtomic } from "../persistence/commit-workflow.ts";
import { findPriorSaveWorkflowApproval } from "../persistence/save-workflow-approval.ts";
import type { ToolContext } from "../tools/index.ts";
import { saveWorkflowDraftTool } from "../tools/save-workflow-draft.ts";
import { wrapTools } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";
import {
  ctx,
  freshConversation,
  readyWorkflowDraft,
  usePolicyGateSaveWorkflowDraftSetup,
} from "./policy-gate-save-workflow-draft-fixtures.ts";
import { freshSignals } from "./turn-signals.ts";

usePolicyGateSaveWorkflowDraftSetup();

describe("commit gate — authorizes on commit_intent.kind, not top-level kind", () => {
  test("PRODUCTION CASE: generic-kind confirm + save_workflow_draft commit_intent authorizes the commit", async () => {
    const conversation_id = await freshConversation();
    const draft = readyWorkflowDraft("commit-gate-prod-case");
    await appendSnapshot(ctx.tenant_id, conversation_id, draft, ctx.testDb.db);

    await ctx.testDb.db.insert(conversationElicitations).values([
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "external write",
        input: { kind: "external_write", target: { tool: "call_connector" } },
        output: { confirmed: true },
        status: "resolved",
      },
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "external write cancelled",
        input: { kind: "external_write", target: { tool: "call_connector" } },
        status: "cancelled",
      },
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "post-exec review",
        input: { kind: "review_after_execution" },
        output: { confirmed: true },
        status: "resolved",
      },
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "save the workflow",
        input: {
          kind: "generic",
          commit_intent: {
            kind: "save_workflow_draft",
            payload: {},
            description: "Save the current workflow draft.",
          },
        },
        output: { confirmed: true },
        status: "resolved",
      },
    ]);

    let liveDraft = draft;
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      ask_before_writing: true,
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db: ctx.testDb.db,
      }),
      getDraft: () => liveDraft,
      setDraft: async (next) => {
        liveDraft = next;
      },
    };

    const result = await commitWorkflowAtomic({ ctx: toolCtx });
    expect(result.ok).toBe(true);
    expect(result.committed_workflow_id).toBeDefined();

    const wfRows = await ctx.testDb.db
      .select()
      .from(workflows)
      .where(eq(workflows.tenant_id, ctx.tenant_id));
    expect(wfRows.find((r) => r.slug === "commit-gate-prod-case")).toBeDefined();
  });

  test("an external_write confirm with NO save-workflow commit_intent does NOT authorize the commit", async () => {
    const conversation_id = await freshConversation();
    const draft = readyWorkflowDraft("commit-gate-no-intent");
    await appendSnapshot(ctx.tenant_id, conversation_id, draft, ctx.testDb.db);

    await ctx.testDb.db.insert(conversationElicitations).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool_name: "ask_user_confirm",
      summary: "external write",
      input: { kind: "external_write", target: { tool: "call_connector" } },
      output: { confirmed: true },
      status: "resolved",
    });

    let liveDraft = draft;
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      ask_before_writing: true,
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db: ctx.testDb.db,
      }),
      getDraft: () => liveDraft,
      setDraft: async (next) => {
        liveDraft = next;
      },
    };

    const result = await commitWorkflowAtomic({ ctx: toolCtx });
    expect(result.ok).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.error_code).toBe("no_prior_approval");
  });

  test("explicitly guarded non-save calls get no elicitation dedup or model-marker bypass", async () => {
    {
      const conversation_id = await freshConversation();
      await ctx.testDb.db.insert(conversationElicitations).values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "run the workflow",
        input: {
          kind: "external_write",
          question: "Run this workflow?",
          target: { tool: "run_workflow", args: {} },
        },
        output: { confirmed: true },
        status: "resolved",
      });

      const events: TurnEvent[] = [];
      const signals = freshSignals();
      const engineClient = new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db: ctx.testDb.db,
      });
      const toolCtx: ToolContext = {
        db: ctx.testDb.db,
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: null,
        connector_id: null,
        workflow_id: null,
        engineClient,
        getDraft: () => ({ workflow: { name: "", steps: [] } }),
        setDraft: async () => {},
      };
      const wrapped = await wrapTools(
        toolCtx,
        signals,
        events,
        ctx.testDb.db,
        ["workflow-authoring"],
        { run_workflow: "confirm_before_execution" },
      );

      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const result = await (wrapped.run_workflow!.execute as any)(
        {
          workflow_id: "00000000-0000-0000-0000-000000000000",
          environment: "prod",
          execute_writes: true,
        },
        { toolCallId: "no-generic-dedup-call", messages: [] },
      );
      expect(result.ok).toBe(false);
      expect(result.pause).toBeDefined();
      expect(result.pause?.tool_name).toBe("ask_user_confirm");
      expect(result.data).toMatchObject({
        pending: true,
        policy_mode: "confirm_before_execution",
      });
      const elicit = events.find((e) => e.type === "elicit_request");
      expect(elicit).toBeDefined();
    }

    {
      const conversation_id = await freshConversation();
      const events: TurnEvent[] = [];
      const signals = freshSignals();
      const engineClient = new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db: ctx.testDb.db,
      });
      const toolCtx: ToolContext = {
        db: ctx.testDb.db,
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: null,
        connector_id: null,
        workflow_id: null,
        engineClient,
        getDraft: () => ({ workflow: { name: "", steps: [] } }),
        setDraft: async () => {},
      };
      const wrapped = await wrapTools(
        toolCtx,
        signals,
        events,
        ctx.testDb.db,
        ["workflow-authoring"],
        { run_workflow: "confirm_before_execution" },
      );

      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const result = await (wrapped.run_workflow!.execute as any)(
        {
          workflow_id: "00000000-0000-0000-0000-000000000000",
          environment: "prod",
          execute_writes: true,
          __policy_confirmed: true,
        },
        { toolCallId: "marker-inert-call", messages: [] },
      );
      expect(result.ok).toBe(false);
      expect(result.pause).toBeDefined();
      expect(result.pause?.tool_name).toBe("ask_user_confirm");
      const elicit = events.find((e) => e.type === "elicit_request");
      expect(elicit).toBeDefined();
    }
  });

  test("policy gate and commit gate agree — both consult the shared predicate", async () => {
    const conversation_id = await freshConversation();
    const draft = readyWorkflowDraft("commit-gate-agreement");
    await appendSnapshot(ctx.tenant_id, conversation_id, draft, ctx.testDb.db);

    await ctx.testDb.db.insert(conversationElicitations).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool_name: "ask_user_confirm",
      summary: "save the workflow",
      input: {
        kind: "generic",
        commit_intent: {
          kind: "save_workflow_draft",
          payload: {},
          description: "Save the current workflow draft.",
        },
      },
      output: { confirmed: true },
      status: "resolved",
    });

    const approval = await findPriorSaveWorkflowApproval(
      ctx.testDb.db,
      ctx.tenant_id,
      conversation_id,
    );
    expect(approval).not.toBeNull();

    let liveDraft = draft;
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      ask_before_writing: true,
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db: ctx.testDb.db,
      }),
      getDraft: () => liveDraft,
      setDraft: async (next) => {
        liveDraft = next;
      },
    };
    const result = await commitWorkflowAtomic({ ctx: toolCtx });
    expect(result.ok).toBe(true);
  });

  test("without the ask-before-writing rule the gate is bypassed — and the audit row says so instead of claiming a manual re-issue", async () => {
    const conversation_id = await freshConversation();
    const draft = readyWorkflowDraft("commit-gate-auto-bypass");
    await appendSnapshot(ctx.tenant_id, conversation_id, draft, ctx.testDb.db);

    let liveDraft = draft;
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db: ctx.testDb.db,
      }),
      getDraft: () => liveDraft,
      setDraft: async (next) => {
        liveDraft = next;
      },
    };

    expect(
      await findPriorSaveWorkflowApproval(ctx.testDb.db, ctx.tenant_id, conversation_id),
    ).toBeNull();

    const result = await saveWorkflowDraftTool.execute(toolCtx, {});
    expect(result.ok).toBe(true);

    const rows = (
      await ctx.testDb.db.select().from(auditLog).where(eq(auditLog.tenant_id, ctx.tenant_id))
    ).filter(
      (r) => (r.metadata as Record<string, unknown> | null)?.slug === "commit-gate-auto-bypass",
    );
    expect(rows.length).toBeGreaterThan(0);

    const toolRow = rows.find(
      (r) => (r.metadata as Record<string, unknown> | null)?.tool === "save_workflow_draft",
    );
    if (!toolRow) throw new Error("expected an audit row for the save_workflow_draft commit");
    expect(toolRow.reason).toBe("auto_mode_no_prior_approval");
    expect((toolRow.metadata as Record<string, unknown>).bypassed_prior_approval).toBe(true);

    expect(rows.some((r) => r.reason === "manual_re_issue")).toBe(false);
    expect(
      rows.filter((r) => r.action === "workflow.updated" || r.action === "workflow.created"),
    ).toHaveLength(1);
  });
});
