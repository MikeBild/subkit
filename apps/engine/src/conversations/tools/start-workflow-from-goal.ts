// start_workflow_from_goal — seed a workflow draft from the user's goal.
//
// Unlike `build_workflow`, this tool does NOT try to shape the full DAG
// in one shot. It records the goal + required connector references as
// draft metadata and primes the draft for staged authoring via
// `propose_step` / `connect_steps` / `update_param`. This removes the
// "big-bang" failure mode that caused `propose_step` failure streaks.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { conversations } from "../../db/schema/index.ts";
import { withWorkflowDraft } from "../authoring-state.ts";
import type { WorkflowDraftDocument } from "../types.ts";
import { buildDraftMutationPayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    name: z.string().min(1).describe("Short name for the workflow — used as the display label."),
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional()
      .describe("Stable slug (lowercase, hyphens). Inferred from the name when omitted."),
    goal: z
      .string()
      .min(1)
      .describe(
        "Free-form description of what this workflow should do from the end-user's perspective.",
      ),
    connector_ids: z
      .array(z.string())
      .default([])
      .describe("Connector ids that this workflow will call."),
    description: z.string().optional(),
    output_schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "JSON-Schema contract for the workflow's FINAL output, derived from the goal. Declare it whenever the goal implies a concrete output shape ('a list of repos with name and stars', 'an email with CPU/memory/disk specs') — keep it minimal (type/properties/required). dry_run_workflow validates the real output against it and refuses a green preview on a mismatch, so the authoring loop has a mechanical done-signal.",
      ),
  })
  .openapi("StartWorkflowFromGoalToolInput");

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export const startWorkflowFromGoalTool: ConversationTool = {
  name: "start_workflow_from_goal",
  description:
    "Seed a workflow draft from the user's goal + required connectors. Use this as the first move before proposing steps so the draft carries goal/connector metadata.",
  use_case:
    "Replaces the one-shot build_workflow pattern when you are authoring a brand-new workflow iteratively. Propose individual steps with propose_step after calling this.",
  important_notes: [
    "Does not emit any steps — use propose_step / connect_steps to grow the draft step by step.",
    "Writes to draft only; save_workflow_draft is still required to persist the workflow.",
    "When the goal implies a concrete output shape, pass a minimal `output_schema` (JSON Schema) derived from the goal — previews then have a mechanical pass/fail signal instead of relying on the user to eyeball the output.",
  ],
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const slug = args.slug ?? slugify(args.name);
    const draft = ctx.getDraft();
    const nextWorkflow: WorkflowDraftDocument = {
      name: args.name,
      slug,
      ...(args.description ? { description: args.description } : {}),
      // The goal-derived output contract (Fix 11) seeds the draft so
      // every subsequent dry-run validates the final output against it.
      ...(args.output_schema ? { output_schema: args.output_schema } : {}),
      steps: [],
    };
    // Stash the goal + connector ids as draft-only metadata so later
    // tools (propose_step, inspect_workflow_draft) can reference them.
    // These keys are ignored by the workflow validator until save_workflow_draft
    // strips the draft down to its WorkflowDef shape.
    const extra: Record<string, unknown> = {
      goal: args.goal,
      connector_ids: args.connector_ids,
    };
    const merged = { ...nextWorkflow, ...extra } as WorkflowDraftDocument;
    const nextDraft = withWorkflowDraft(draft, merged, "workflow_seeded_from_goal");
    await ctx.setDraft(nextDraft);
    // Detach from any previously-saved workflow target. The LLM is
    // explicitly seeding a fresh draft here; if the conversation row
    // still pointed at an earlier workflow, save_workflow_draft would silently
    // overwrite it. The identity gate in commit-workflow.ts also
    // protects against this, but resetting here means downstream tools
    // (inspect, dry_run) see a clean target_workflow_id state too.
    await ctx.db
      .update(conversations)
      .set({ target_workflow_id: null, updated_at: new Date() })
      .where(
        and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, ctx.conversation_id)),
      );
    return {
      ok: true,
      data: buildDraftMutationPayload(nextDraft, {
        resource_kind: "workflow",
        extra: {
          name: args.name,
          steps: 0,
          workflow: {
            name: args.name,
            slug,
            goal: args.goal,
            connector_ids: args.connector_ids,
            step_count: 0,
          },
          next_hint:
            "Propose the first step with propose_step. Preview with dry_run_step before committing.",
        },
      }),
    };
  },
};
