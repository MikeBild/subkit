// `author_workflow` — the canonical entry for authoring a NEW (or
// fully-replaced) workflow. One call runs the engine-side one-shot
// pipeline (`conversations/authoring-pipeline.ts`): ground in the named
// connectors' recorded samples + docs → ONE schema-constrained
// generation (JS-first transforms) → validate + recorded-eval (bounded
// repair armed) → stash the complete evaluated draft with the goal.
//
// The conversation model receives a ready-to-preview draft from ONE
// tool call instead of micro-iterating across propose_step /
// update_param. The next move is always `dry_run_workflow`.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { conversations } from "../../db/schema/index.ts";
import { runAuthoringPipeline } from "../authoring-pipeline.ts";
import { emitRecordedEvalSignals } from "../recorded-eval.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    goal: z
      .string()
      .min(1)
      .describe(
        "The user's goal VERBATIM — what this workflow should achieve from the end-user's perspective. Quoted into the generation prompt and stashed on the draft for the preview judge.",
      ),
    connector_ids: z
      .array(z.string())
      .default([])
      .describe("Connector ids (UUIDs) this workflow will call."),
    connector_slugs: z
      .array(z.string())
      .default([])
      .describe("Connector slugs this workflow will call (resolved tenant-scoped)."),
    input_example: z
      .unknown()
      .optional()
      .describe("Concrete example of the workflow input payload, when the user supplied one."),
  })
  .openapi("AuthorWorkflowToolInput");

export const authorWorkflowTool: ConversationTool = {
  name: "author_workflow",
  description:
    "THE canonical entry for authoring a NEW or fully-replaced workflow. One call runs the engine-side pipeline — ground in the named connectors (recorded endpoint samples + docs), generate the COMPLETE definition (JavaScript transforms by default), evaluate it against recorded evidence with bounded auto-repair — and returns the evaluated draft. Then call dry_run_workflow.",
  use_case:
    "Use whenever the user asks to build/create/author a workflow. Replaces the propose_step/update_param micro-iteration for initial authoring; those are repair-stage tools for applying specific findings afterwards.",
  important_notes: [
    "Writes to the conversation draft only — dry_run_workflow is the next step; a green, judged preview auto-commits.",
    "Pass the user's goal VERBATIM. It grounds generation and drives the post-preview judge.",
    "Name every connector the workflow should call (ids or slugs) — their recorded endpoint samples and docs ground the generation. Probe a connector first when it has never been called; recorded shapes make the difference between a grounded draft and a guessed one.",
    "The result's `recorded_eval` may carry findings and verified `repair` proposals. The draft is stashed regardless — apply repairs via edit_workflow_patch / update_param, then preview.",
    "No live HTTP fires inside this call; generation cost rides the tenant token budget (≤2 generation passes + bounded expression repair).",
  ],
  requires_skill: "workflow-authoring",
  example_input: {
    goal: "Every weekday at 9am, email me the name and droplet specs of every DigitalOcean project",
    connector_slugs: ["digitalocean", "gmail"],
  },
  inputSchema,
  category: "draft_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const connectorRefs = [...new Set([...args.connector_ids, ...args.connector_slugs])];
    const currentSlug = ctx.getDraft().workflow?.slug ?? null;

    const result = await runAuthoringPipeline({
      ctx,
      goal: args.goal,
      connector_ids: connectorRefs,
      ...(args.input_example !== undefined ? { input_example: args.input_example } : {}),
    });

    if (!result.ok) {
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: result.error_code,
          message: result.message,
          recommended_mode: "workflow",
          next_best_actions:
            result.error_code === "authoring_connectors_unresolved"
              ? ["list_connectors", "find_connector", "author_workflow"]
              : ["author_workflow", "build_workflow"],
          extra: {
            errors: result.errors,
            attempts: result.attempts,
            ...(result.unresolved_connectors.length > 0
              ? { unresolved_connectors: result.unresolved_connectors }
              : {}),
          },
        }),
      };
    }

    emitRecordedEvalSignals({
      tool: "author_workflow",
      conversation_id: ctx.conversation_id,
      report: result.recorded_eval,
    });

    // Detach from any previously-saved workflow target when this call
    // replaces the draft with a different slug — same discipline as
    // build_workflow / start_workflow_from_goal, so a later commit
    // never keys its upsert on a stale workflow id.
    if (currentSlug !== result.definition.slug) {
      await ctx.db
        .update(conversations)
        .set({ target_workflow_id: null, updated_at: new Date() })
        .where(
          and(
            eq(conversations.tenant_id, ctx.tenant_id),
            eq(conversations.id, ctx.conversation_id),
          ),
        );
    }

    const nextDraft = ctx.getDraft();
    return {
      ok: true,
      data: buildDraftMutationPayload(nextDraft, {
        resource_kind: "workflow",
        extra: {
          name: result.definition.name,
          workflow: {
            name: result.definition.name,
            slug: result.definition.slug,
            goal: args.goal,
            step_count: result.definition.steps.length,
          },
          definition: result.definition,
          validation: result.validation,
          recorded_eval: result.recorded_eval,
          attempts: result.attempts,
          ...(result.unresolved_connectors.length > 0
            ? { unresolved_connectors: result.unresolved_connectors }
            : {}),
          persistence: "draft_only" as const,
          next_step: result.next,
          next_hint: result.recorded_eval.ok
            ? "Preview with dry_run_workflow — a green, judged preview auto-commits."
            : "Apply the recorded_eval findings (verified repairs ride findings[].repair.expression) via edit_workflow_patch / update_param, then dry_run_workflow.",
        },
      }),
    };
  },
};
