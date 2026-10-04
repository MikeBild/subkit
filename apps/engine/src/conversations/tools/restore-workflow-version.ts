import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { workflows } from "../../db/schema/index.ts";
import { restoreWorkflowVersion, VersionNotRestorableError } from "../../workflows/versions.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    workflow_id: z
      .string()
      .uuid()
      .optional()
      .describe("Workflow id to restore. Provide this or `slug`."),
    slug: z
      .string()
      .min(1)
      .optional()
      .describe("Workflow slug. Ignored when `workflow_id` is set."),
    version: z
      .number()
      .int()
      .min(1)
      .describe("The version number to make active again. Read it from get_workflow's history."),
  })
  .openapi("RestoreWorkflowVersionToolInput");

async function resolveWorkflowIdBySlug(ctx: ToolContext, slug: string): Promise<string | null> {
  const rows = await ctx.db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.slug, slug)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export const restoreWorkflowVersionTool: ConversationTool = {
  name: "restore_workflow_version",
  description:
    "Make a previous version of a SAVED workflow the active one again — the recovery move after a bad save. Identify the workflow by `workflow_id` or `slug` and name the `version` to restore. This replaces what is currently live, so it needs a person to approve it. For rolling back the conversation's unsaved draft use restore_draft_snapshot instead.",
  inputSchema,
  category: "tenant_write" as const,
  authoring_resource: "workflow",
  use_case:
    "Use when a saved workflow's current version is wrong and an earlier one was correct — e.g. a commit overwrote working logic. Never guess the version number: read the history first.",
  important_notes: [
    "This changes what runs in production. The version you name becomes the active one; the current definition is kept in history, not discarded.",
    "Restoring is not a repair. If you do not know which version was good, say so and ask — do not try versions until one looks right.",
    "Requires `workflow:restore` on the workflow, the same permission the HTTP route enforces. A confirmation does not substitute for it.",
  ],
  example_input: { slug: "invoice-sync", version: 1 },
  permission: {
    action: "workflow:restore",
    resourceType: "workflow",
    resolveResourceId: async (ctx, rawArgs) => {
      if (rawArgs.workflow_id) return String(rawArgs.workflow_id);
      if (!rawArgs.slug) return null;
      return await resolveWorkflowIdBySlug(ctx, String(rawArgs.slug));
    },
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);

    let workflowId = args.workflow_id ?? null;
    if (!workflowId) {
      if (!args.slug) {
        return {
          ok: false,
          data: {
            error_code: "workflow_not_identified",
            message: "restore_workflow_version needs either `workflow_id` or `slug`.",
            next_best_actions: ["find_workflow", "list_workflows"],
          },
        };
      }
      workflowId = await resolveWorkflowIdBySlug(ctx, args.slug);
      if (!workflowId) {
        return {
          ok: false,
          data: {
            error_code: "workflow_not_found",
            message: `no workflow with slug "${args.slug}" in this tenant`,
            next_best_actions: ["find_workflow", "list_workflows"],
          },
        };
      }
    }

    let restored: Awaited<ReturnType<typeof restoreWorkflowVersion>>;
    try {
      restored = await restoreWorkflowVersion(
        ctx.tenant_id,
        workflowId,
        args.version,
        ctx.actor_id,
        ctx.db,
      );
    } catch (error) {
      if (!(error instanceof VersionNotRestorableError)) throw error;
      return {
        ok: false,
        data: {
          error_code: error.code,
          message: error.message,
          next_best_actions: ["get_workflow", "inspect_workflow"],
          extra: {
            workflow_id: workflowId,
            requested_version: args.version,
            issues: error.issues,
          },
        },
      };
    }
    if (!restored) {
      return {
        ok: false,
        data: {
          error_code: "workflow_version_not_found",
          message: `workflow ${workflowId} has no version ${args.version}`,
          next_best_actions: ["get_workflow", "inspect_workflow"],
          extra: { workflow_id: workflowId, requested_version: args.version },
        },
      };
    }

    return {
      ok: true,
      data: {
        workflow_id: restored.id,
        slug: restored.slug,
        restored_from_version: args.version,
        current_version: restored.current_version,
        message: `workflow "${restored.slug}" is back on the content of version ${args.version} (now active as version ${restored.current_version})`,
      },
    };
  },
};
