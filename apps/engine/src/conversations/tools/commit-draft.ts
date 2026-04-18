// commit_draft — persist the draft as a real workflow.
//
// Requires a prior `ask_user_confirm { kind: "commit_draft" }`
// elicitation resolved with `{ confirmed: true }`. On success the
// workflow id is recorded on the conversation and the loop ends.

import { z } from "@hono/zod-openapi";
import { and, desc, eq, sql } from "drizzle-orm";
import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import { createWorkflow } from "../../workflows/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("CommitDraftToolInput");

export const commitDraftTool: ConversationTool = {
  name: "commit_draft",
  description: "Persist the draft as a real workflow. Requires a prior approval.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, _args): Promise<ToolResult> {
    // Must have at least one resolved `ask_user_confirm` elicitation
    // whose input.kind is "commit_draft" and output.confirmed is true.
    const rows = await ctx.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, ctx.tenant_id),
          eq(conversationElicitations.conversation_id, ctx.conversation_id),
          eq(conversationElicitations.tool_name, "ask_user_confirm"),
          sql`(${conversationElicitations.input} ->> 'kind') = 'commit_draft'`,
        ),
      )
      .orderBy(desc(conversationElicitations.created_at))
      .limit(1);
    const head = rows[0];
    const confirmed =
      head?.status === "resolved" &&
      typeof head.output === "object" &&
      head.output !== null &&
      (head.output as { confirmed?: unknown }).confirmed === true;
    if (!head || !confirmed) {
      return {
        ok: false,
        data: {
          error:
            "commit_draft requires a resolved ask_user_confirm { kind: commit_draft, confirmed: true }",
          reason: "no_approval",
          latest_elicitation_status: head?.status ?? null,
        },
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

    let result: Awaited<ReturnType<typeof createWorkflow>>;
    try {
      result = await createWorkflow(
        { tenant_id: ctx.tenant_id, def, actor_id: ctx.actor_id },
        ctx.db,
      );
    } catch (err) {
      // Postgres raises 23505 on a unique-constraint violation — the
      // `workflows_tenant_slug_uniq` index most of the time. Drizzle
      // wraps this and the surface message can be `Failed query: ...`
      // with no "duplicate" substring, so check multiple signals:
      // the raw message, `err.code`, `err.cause.code`, and fall back
      // to assuming slug conflict on any insert into `workflows`
      // because that's the only realistic failure mode after the
      // draft passed validation.
      const msg = err instanceof Error ? err.message : String(err);
      const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
      const code = (err as { code?: string }).code ?? cause?.code;
      const constraint = (err as { constraint?: string }).constraint ?? cause?.constraint ?? "";
      const looksLikeSlugConflict =
        code === "23505" ||
        msg.includes("23505") ||
        msg.toLowerCase().includes("duplicate key") ||
        constraint.includes("workflows_tenant_slug") ||
        constraint.includes("workflows_slug") ||
        msg.includes('insert into "workflows"');
      if (looksLikeSlugConflict) {
        const attempted = def.slug ?? def.name;
        return {
          ok: false,
          data: {
            errors: [
              {
                path: "slug",
                message: `a workflow with slug "${attempted}" already exists for this tenant — pick a different slug (e.g. "${attempted}-${Date.now().toString(36)}") and call commit_draft again`,
              },
            ],
            reason: "duplicate_slug",
            attempted_slug: attempted,
          },
        };
      }
      return {
        ok: false,
        data: { error: msg, reason: "commit_failed" },
      };
    }
    if ("errors" in result) {
      return {
        ok: false,
        data: {
          errors: result.errors,
          reason: "invalid_final_draft",
          step_count: def.steps.length,
        },
      };
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
