// `restore_workflow_version` — make a previous PERSISTED version of a workflow
// the active one again.
//
// Not to be confused with `restore_draft_snapshot`, which rolls back the
// conversation's in-flight draft. This one touches the saved workflow: the
// recovery move for "the last save was wrong".
//
// Why it exists: the capability lived in the HTTP API
// (`POST /v1/workflows/{id}/restore/{version}`) and nowhere in the tool
// palette. When a bad version landed in production, the operating session
// could SEE the damage and not undo it — so it reached for an HTTP connector
// pointed at the engine's own API instead, leaving the governed surface
// (per-tool RBAC, the confirm gate, `commit_intent_kind` audit tagging) to do
// something entirely legitimate. A capability an agent needs and cannot reach
// does not stay unreached; it gets reached around.
//
// Gated like the other destructive workflow tools: `confirm_before_execution`
// AND dangerous (see `tool-policies.ts`), so `permission_mode: auto` cannot
// short-circuit it. Restoring is as consequential as overwriting — it replaces
// what is live.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { workflows } from "../../db/schema/index.ts";
import { restoreWorkflowVersion } from "../../workflows/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

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
  ],
  example_input: { slug: "radar-normalize-run", version: 1 },
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
      const rows = await ctx.db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.slug, args.slug)))
        .limit(1);
      workflowId = rows[0]?.id ?? null;
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

    // `restoreWorkflowVersion` returns null when the (workflow, version) pair
    // does not exist. Surface that as a typed envelope rather than letting a
    // null flow onward — a wrong version number is an ordinary mistake the
    // model should correct from the history, not a crash.
    const restored = await restoreWorkflowVersion(
      ctx.tenant_id,
      workflowId,
      args.version,
      ctx.actor_id,
      ctx.db,
    );
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
