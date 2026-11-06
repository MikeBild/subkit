import { afterAll, beforeAll } from "bun:test";
import "../tools/index.ts";
import { eq } from "drizzle-orm";
import { workflows, workflowVersions } from "../../db/schema/index.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

export let ctx: ConversationTestCtx;

export async function seedWorkflow(slug = "berlin-weather"): Promise<{
  workflow_id: string;
  version_id: string;
}> {
  const [workflow] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug,
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
        slug,
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
            expression: "return { date: input.input.date };",
            language: "javascript",
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

export function buildToolCtx(params: {
  conversation_id: string;
  draft: DraftDocument;
  setDraft: (next: DraftDocument) => Promise<void>;
  afterWorkflowRead?: (id: string) => Promise<void>;
  recentUserMessage?: string;
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
        const workflow = await getWorkflow(ctx.tenant_id, id, ctx.testDb.db);
        await params.afterWorkflowRead?.(id);
        return workflow;
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
    principal: {
      provider: "test",
      kind: "user",
      id: ctx.user_id,
      tenant_id: ctx.tenant_id,
      roles: ["admin"],
    },
    connector_id: null,
    workflow_id: null,
    permission_mode: "auto",
    ...(params.recentUserMessage ? { recentUserMessage: params.recentUserMessage } : {}),
    engineClient: engineClientStub,
    getDraft: () => params.draft,
    setDraft: params.setDraft,
  };
}

export function useRunWorkflowToolSetup(): void {
  beforeAll(async () => {
    ctx = await createConversationTestCtx("run_workflow_tool");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });
}
