// commit_draft — persist the draft as a real workflow.
//
// Requires a prior approval in the `approved` state. On success the
// workflow id is recorded on the conversation and the loop ends.

import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { approvalRequests, conversations } from "../../db/schema/index.ts";
import { createWorkflow } from "../../workflows/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("CommitDraftToolInput");

export const commitDraftTool: ConversationTool = {
  name: "commit_draft",
  description: "Persist the draft as a real workflow. Requires a prior approval.",
  inputSchema,
  async execute(ctx, _args): Promise<ToolResult> {
    // Must have at least one approved `commit_draft` approval row.
    const rows = await ctx.db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenant_id, ctx.tenant_id),
          eq(approvalRequests.conversation_id, ctx.conversation_id),
          eq(approvalRequests.kind, "commit_draft"),
        ),
      )
      .orderBy(desc(approvalRequests.created_at))
      .limit(1);
    const head = rows[0];
    if (!head || head.status !== "approved") {
      return {
        ok: false,
        data: { error: "commit_draft requires an approved commit_draft approval" },
      };
    }

    const draft = ctx.getDraft();
    // Drop any non-workflow helper fields (e.g. edges hint) before
    // the validator sees them.
    const def = {
      name: draft.name,
      ...(draft.slug ? { slug: draft.slug } : {}),
      ...(draft.description ? { description: draft.description } : {}),
      ...(draft.input_schema ? { input_schema: draft.input_schema } : {}),
      ...(draft.output_schema ? { output_schema: draft.output_schema } : {}),
      steps: draft.steps,
    };

    const result = await createWorkflow(
      { tenant_id: ctx.tenant_id, def, actor_id: ctx.actor_id },
      ctx.db,
    );
    if ("errors" in result) {
      return { ok: false, data: { errors: result.errors } };
    }
    const workflow = result.workflow;
    await ctx.db
      .update(conversations)
      .set({
        target_workflow_id: workflow.id,
        status: "committed",
        updated_at: new Date(),
      })
      .where(eq(conversations.id, ctx.conversation_id));
    return {
      ok: true,
      data: { workflow_id: workflow.id, slug: workflow.slug },
      committed_workflow_id: workflow.id,
    };
  },
};
