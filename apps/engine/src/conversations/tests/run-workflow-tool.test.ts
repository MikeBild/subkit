import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import { runWorkflowTool } from "../tools/generated/writes/run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("run_workflow_tool");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedWorkflow(): Promise<{
  workflow_id: string;
  version_id: string;
}> {
  const [workflow] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug: "berlin-weather",
      name: "Berlin Weather",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("workflow insert failed");
  const [version] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: "Berlin Weather",
        slug: "berlin-weather",
        input_schema: {
          type: "object",
          required: ["date"],
          properties: {
            date: { type: "string" },
          },
        },
        steps: [
          {
            id: "shape",
            kind: "transform",
            expression: '{ "date": $input.date }',
            language: "jsonata",
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("workflow version insert failed");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  return { workflow_id: workflow.id, version_id: version.id };
}

function buildToolCtx(params: {
  conversation_id: string;
  draft: DraftDocument;
  setDraft: (next: DraftDocument) => Promise<void>;
}): ToolContext {
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub matching ToolContext
  const engineClientStub: any = {
    context: {
      actor_id: ctx.user_id,
      actor_type: "user",
    },
    workflows: {
      get: async (id: string) => {
        const { getWorkflow } = await import("../../workflows/service.ts");
        return getWorkflow(ctx.tenant_id, id, ctx.testDb.db);
      },
    },
    audit_write: async (entry: Record<string, unknown>) => {
      const { auditAwait } = await import("../../audit/audit.ts");
      const { AuditAction } = await import("../../audit/types.ts");
      return auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: "user",
          actor_id: ctx.user_id,
          action: AuditAction.EXECUTION_STARTED,
          resource_type: String(entry.resource_type),
          resource_id: String(entry.resource_id),
          result: (entry.result as "success" | "error" | "denied") ?? "success",
          metadata: {
            via_action: String(entry.action),
            ...((entry.metadata as Record<string, unknown>) ?? {}),
          },
        },
        ctx.testDb.db,
      );
    },
  };
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: params.conversation_id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    permission_mode: "auto",
    engineClient: engineClientStub,
    getDraft: () => params.draft,
    setDraft: params.setDraft,
  };
}

describe("run_workflow tool", () => {
  test("binds the saved workflow into the next draft and normalizes stringified input", async () => {
    const { workflow_id } = await seedWorkflow();
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({
        tenant_id: ctx.tenant_id,
        status: "active",
        draft: {
          workflow: { name: "new-workflow", steps: [] },
          state: {
            mode: "execution",
            stage: "workflow_executed",
            connector_mutation_seq: 0,
            workflow_mutation_seq: 0,
            checkpoints: {},
            persisted_resources: [],
            latest_execution: null,
            latest_diagnosis: null,
          },
        },
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");

    let nextDraft: unknown = null;
    const result = await runWorkflowTool.execute(
      buildToolCtx({
        conversation_id: conversation.id,
        draft: conversation.draft as DraftDocument,
        setDraft: async (draft) => {
          nextDraft = draft;
        },
      }),
      {
        workflow_id,
        environment: "dev",
        input: '{"date":"tomorrow +1"}',
      },
    );

    expect(result.ok).toBe(true);
    if (!nextDraft) throw new Error("next draft was not captured");
    const capturedDraft = nextDraft as DraftDocument;
    expect(capturedDraft.summary?.active_target).toEqual({
      kind: "workflow",
      id: workflow_id,
      slug: "berlin-weather",
      name: "Berlin Weather",
      environment: null,
      lifecycle_state: "persisted",
    });
    expect(capturedDraft.summary?.persisted_resources).toEqual([
      expect.objectContaining({
        kind: "workflow",
        id: workflow_id,
        slug: "berlin-weather",
        name: "Berlin Weather",
      }),
    ]);
    expect(capturedDraft.summary?.missing_fields).not.toContain("workflow.steps");

    const conversationRows = await ctx.testDb.db
      .select({ target_workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(eq(conversations.id, conversation.id))
      .limit(1);
    expect(conversationRows[0]?.target_workflow_id).toBe(workflow_id);

    const executionAuditRows = await ctx.testDb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.resource_type, "execution"));
    expect(executionAuditRows.length).toBeGreaterThan(0);
  });
});
