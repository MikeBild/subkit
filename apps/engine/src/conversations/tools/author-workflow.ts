import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { conversations } from "../../db/schema/index.ts";
import { runAuthoringPipeline } from "../authoring-pipeline.ts";
import { persistedWorkflowResource } from "../authoring-state/summary.ts";
import { getWorkflowDraft, startNewWorkflowDraft, withWorkflowDraft } from "../authoring-state.ts";
import { emitRecordedEvalSignals } from "../recorded-eval.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { resolveSavedWorkflow } from "./open-workflow-draft.ts";
import { PLACEHOLDER_DESTINATION_NEXT_ACTIONS } from "./placeholder-destination-gate.ts";

const inputSchema = z
  .object({
    goal: z
      .string()
      .min(1)
      .describe(
        "The user's goal VERBATIM — what this workflow should achieve from the end-user's perspective. Quoted into the generation prompt and stashed on the draft for the preview judge.",
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The exact workflow name requested by the user. Applied to the draft before review and saving; never defer naming to a persisted metadata update.",
      ),
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional()
      .describe(
        "The exact lowercase workflow identifier requested by the user, when supplied. Preserved over the generated identifier before review.",
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
      .describe(
        "A concrete SAMPLE of the workflow's input payload (an object with the named keys the run needs, e.g. { markdown: '# Deck', filename: 'deck.md' }). PREFERRED over declaring an input_schema by hand: it grounds generation AND is persisted as the workflow's `input_schema_sample`, from which the run/dry-run input contract (with a real required-list) is derived. This is the author's canonical example — NOT a throwaway test payload passed to dry_run_workflow (those are never written into the workflow).",
      ),
  })
  .openapi("AuthorWorkflowToolInput");

export const authorWorkflowTool: ConversationTool = {
  name: "author_workflow",
  description:
    "THE canonical entry for authoring a NEW workflow. Never for an existing one: a slug that is already saved is refused with workflow_already_exists — open it with open_workflow_draft and change it with edit_workflow_patch. One call runs the engine-side pipeline — ground in the named connectors (recorded endpoint samples + docs), generate the COMPLETE definition (JavaScript transforms by default), evaluate it against recorded evidence with bounded auto-repair — and returns the evaluated draft. Set the requested name and slug on the draft, then inspect it. Preview ordinary definitions; inspect and validate sensitive definitions before saving them inactive.",
  use_case:
    "Use whenever the user asks to build/create/author a workflow. This is THE builder; apply targeted follow-up edits afterwards with edit_workflow_patch.",
  important_notes: [
    "Writes to the conversation draft only. Ordinary definitions use dry_run_workflow next; a green, judged preview auto-commits. Sensitive definitions use inspect_workflow_draft and validate_draft before an inert save, without chat preview.",
    "Pass the user's goal VERBATIM and pass any explicitly requested name/slug in their fields. Verify them before preview or sensitive-draft review; an ordinary green preview can save immediately. Do not defer requested naming to update_workflow after saving.",
    "When the user supplied (or you can infer) an example input payload, pass it as `input_example`. It is persisted as the workflow's sample and becomes the input contract the run/dry-run present — a far more reliable idiom than hand-writing an input_schema. A run/dry-run TEST payload is a separate thing and is never written into the workflow.",
    "Name every connector the workflow should call (ids or slugs) — their recorded endpoint samples and docs ground the generation. Probe a connector first when it has never been called; recorded shapes make the difference between a grounded draft and a guessed one.",
    "The result's `recorded_eval` may carry findings and verified `repair` proposals; a valid definition is stashed with them — apply repairs via edit_workflow_patch, then preview ordinary definitions or inspect and validate sensitive definitions. A definition that fails workflow validation is never stashed: the call refuses with authoring_definition_invalid and the previous draft stays.",
    "Destinations (recipients, channels, webhook URLs, upload targets) come from the user: when the goal does not name them, ask with ask_user_text/ask_user_form BEFORE calling this tool. A generated definition that fills a destination with a placeholder is refused with authoring_definition_invalid, `requires_user_input: true` and `placeholder_destinations` naming each field; never retry with another placeholder.",
    "No live HTTP fires inside this call; generation cost rides the tenant token budget (≤2 generation passes + bounded expression repair).",
  ],
  requires_skill: "workflow-authoring",
  inputSchema,
  category: "draft_write",
  authoring_resource: "workflow",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const connectorRefs = [...new Set([...args.connector_ids, ...args.connector_slugs])];
    const currentSlug = ctx.getDraft().workflow?.slug ?? null;

    const draftState = ctx.getDraft().state;
    const bound = draftState ? persistedWorkflowResource(draftState) : null;
    const targetsBound =
      bound !== null &&
      (ctx.getDraft().workflow?.steps?.length ?? 0) > 0 &&
      (args.slug === undefined || args.slug === (bound.slug ?? currentSlug));
    if (targetsBound) {
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: "rewrite_of_bound_workflow",
          message: `this conversation is bound to the saved workflow "${bound.slug ?? currentSlug ?? bound.id}"${bound.version ? ` (version ${bound.version})` : ""}. author_workflow regenerates the whole definition and would drop every guard the saved version has that the goal does not restate. Change it with edit_workflow_patch (step_patches by step_id; add steps with op "add" at /steps/-; replace a whole step with op "replace" at /steps/N), however many operations that takes — patches can express any redesign. There is no override for this.`,
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft", "edit_workflow_patch"],
        }),
      };
    }

    if (args.slug !== undefined) {
      const existing = await resolveSavedWorkflow(ctx, args.slug);
      if (existing && existing.slug === args.slug && existing.id !== bound?.id) {
        return {
          ok: false,
          data: buildGateError(ctx.getDraft(), {
            error_code: "workflow_already_exists",
            message: `a saved workflow "${existing.slug}" already exists (${existing.id}). author_workflow builds a new workflow from scratch and would discard its saved definition. Open it with open_workflow_draft { workflow: "${existing.slug}" }, which starts from the saved definition, and change it with edit_workflow_patch. To build a separate workflow, choose a slug that is not taken.`,
            recommended_mode: "workflow",
            next_best_actions: ["open_workflow_draft", "edit_workflow_patch"],
            extra: { existing_workflow: existing },
          }),
        };
      }
    }

    const result = await runAuthoringPipeline({
      ctx,
      goal: args.goal,
      connector_ids: connectorRefs,
      ...(args.input_example !== undefined ? { input_example: args.input_example } : {}),
    });

    if (!result.ok) {
      const placeholderDestinations = result.placeholder_destinations ?? [];
      const askFirst = placeholderDestinations.length > 0;
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: result.error_code,
          message: result.message,
          recommended_mode: "workflow",
          requires_user_input: askFirst,
          next_best_actions: askFirst
            ? [...PLACEHOLDER_DESTINATION_NEXT_ACTIONS]
            : result.error_code === "authoring_connectors_unresolved"
              ? ["list_connectors", "find_connector", "author_workflow"]
              : result.error_code === "llm_provider_limited" ||
                  result.error_code === "llm_quota_exhausted"
                ? []
                : result.error_code === "authoring_definition_invalid"
                  ? ["author_workflow"]
                  : ["author_workflow", "edit_workflow_patch"],
          extra: {
            errors: result.errors,
            attempts: result.attempts,
            ...(result.unresolved_connectors.length > 0
              ? { unresolved_connectors: result.unresolved_connectors }
              : {}),
            ...(askFirst ? { placeholder_destinations: placeholderDestinations } : {}),
          },
        }),
      };
    }

    if (args.name !== undefined) result.definition.name = args.name;
    if (args.slug !== undefined) result.definition.slug = args.slug;

    emitRecordedEvalSignals({
      tool: "author_workflow",
      conversation_id: ctx.conversation_id,
      report: result.recorded_eval,
    });

    if (currentSlug !== result.definition.slug) {
      if (bound) {
        await ctx.setDraft(
          withWorkflowDraft(
            startNewWorkflowDraft(ctx.getDraft()),
            getWorkflowDraft(ctx.getDraft()),
            "workflow_authored_one_shot",
          ),
        );
        ctx.workflow_id = null;
      }
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

    if (
      args.name !== undefined ||
      args.slug !== undefined ||
      (args.input_example !== undefined && args.input_example !== null)
    ) {
      const withSample = {
        ...getWorkflowDraft(ctx.getDraft()),
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.slug !== undefined ? { slug: args.slug } : {}),
        ...(args.input_example !== undefined && args.input_example !== null
          ? { input_schema_sample: args.input_example }
          : {}),
      };
      await ctx.setDraft(
        withWorkflowDraft(ctx.getDraft(), withSample, "workflow_authored_one_shot"),
      );
    }

    const nextDraft = ctx.getDraft();
    const sensitiveDefinition = result.definition.execution_privacy === "sensitive";
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
          ...(result.critic_rejection ? { critic_rejection: result.critic_rejection } : {}),
          persistence: "draft_only" as const,
          next_step: result.next,
          next_hint: sensitiveDefinition
            ? result.recorded_eval.ok
              ? "Inspect and validate the draft, then save it inactive. Chat preview is unavailable for sensitive definitions."
              : "Apply the recorded_eval findings via edit_workflow_patch, then inspect and validate before an inactive save. Chat preview is unavailable for sensitive definitions."
            : result.recorded_eval.ok
              ? "Preview with dry_run_workflow — a green, judged preview auto-commits."
              : "Apply the recorded_eval findings (verified repairs ride findings[].repair.expression) via edit_workflow_patch, then dry_run_workflow.",
        },
      }),
    };
  },
};
