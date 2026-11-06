import { z } from "@hono/zod-openapi";
import { runAuthoringPipeline } from "../authoring-pipeline.ts";
import { nextActionsForNeeds } from "../authoring-regrounding.ts";
import { persistedWorkflowResource } from "../authoring-state/summary.ts";
import { getWorkflowDraft, startNewWorkflowDraft, withWorkflowDraft } from "../authoring-state.ts";
import { saveApprovalReadiness } from "../persistence/save-workflow-approval.ts";
import { emitRecordedEvalSignals } from "../recorded-eval.ts";
import { setConversationWorkflowTarget } from "../service/tool-state.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";
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

const MAX_SLUG_SUFFIX = 20;

export async function slugPastArchived(ctx: ToolContext, slug: string): Promise<string> {
  const existing = await resolveSavedWorkflow(ctx, slug);
  if (existing?.slug !== slug || existing.lifecycle !== "archived") return slug;
  for (let suffix = 2; suffix <= MAX_SLUG_SUFFIX; suffix += 1) {
    const candidate = `${slug}-${suffix}`;
    if (!(await resolveSavedWorkflow(ctx, candidate))) return candidate;
  }
  return slug;
}

export const authorWorkflowTool: ConversationTool = {
  name: "author_workflow",
  description:
    "THE canonical entry for authoring a NEW workflow. Never for an existing one: a slug that is already saved is refused with workflow_already_exists — open it with open_workflow_draft and change it with edit_workflow_patch. One call runs the engine-side pipeline — ground in the named connectors (recorded endpoint samples + docs), generate the COMPLETE definition (JavaScript transforms by default), evaluate it against recorded evidence with bounded auto-repair — and returns the evaluated draft. Set the requested name and slug on the draft, then inspect it and preview it. A sensitive definition previews as a metadata-only test run.",
  use_case:
    "Use whenever the user asks to build/create/author a workflow. This is THE builder; apply targeted follow-up edits afterwards with edit_workflow_patch.",
  important_notes: [
    "Writes to the conversation draft only. Definitions use dry_run_workflow next; a green, judged ordinary preview auto-commits. A sensitive definition gets a metadata-only test run (statuses, counts, check verdicts, never values) and then waits for an explicit inactive save.",
    "Pass the user's goal VERBATIM and pass any explicitly requested name/slug in their fields. Verify them before preview; an ordinary green preview can save immediately. Do not defer requested naming to update_workflow after saving.",
    "When the user supplied (or you can infer) an example input payload, pass it as `input_example`. It is persisted as the workflow's sample and becomes the input contract the run/dry-run present — a far more reliable idiom than hand-writing an input_schema. A run/dry-run TEST payload is a separate thing and is never written into the workflow.",
    "Name every connector the workflow should call (ids or slugs) — their recorded endpoint samples and docs ground the generation. Probe a connector first when it has never been called; recorded shapes make the difference between a grounded draft and a guessed one.",
    "The result's `recorded_eval` may carry findings and verified `repair` proposals; a valid definition is stashed with them — apply repairs via edit_workflow_patch, then preview with dry_run_workflow (metadata-only for sensitive definitions). A definition that fails workflow validation is never stashed: the call refuses with authoring_definition_invalid and the previous draft stays.",
    "Destinations (recipients, channels, webhook URLs, upload targets) come from the user: when the goal does not name them, ask with ask_user_text/ask_user_form BEFORE calling this tool. A generated definition that fills a destination with a placeholder is refused with authoring_definition_invalid, `requires_user_input: true` and `placeholder_destinations` naming each field; never retry with another placeholder.",
    "When generation aborts for missing evidence, the result lists `needs`. The engine already re-grounded the named routes and recorded shapes once; follow `next_best_actions` (discover, probe or fetch docs for the named operation) before calling again. With `requires_user_input: true`, ask the user with the prefilled `user_prompt` payload — its default is the production or approved connector — and never guess the answer.",
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
      if (
        existing &&
        existing.slug === args.slug &&
        existing.id !== bound?.id &&
        existing.lifecycle !== "archived"
      ) {
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
      const needs = result.needs ?? [];
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: result.error_code,
          message: result.message,
          recommended_mode: "workflow",
          requires_user_input: askFirst || result.requires_user_input === true,
          next_best_actions: askFirst
            ? [...PLACEHOLDER_DESTINATION_NEXT_ACTIONS]
            : needs.length > 0 || result.user_prompt
              ? nextActionsForNeeds(needs, result.user_prompt ?? null)
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
            ...(needs.length > 0 ? { needs } : {}),
            ...(result.user_prompt ? { user_prompt: result.user_prompt } : {}),
            ...(result.regrounded ? { regrounded: true } : {}),
          },
        }),
      };
    }

    if (args.name !== undefined) result.definition.name = args.name;
    if (args.slug !== undefined) result.definition.slug = args.slug;
    const authoredSlug = result.definition.slug;
    result.definition.slug = await slugPastArchived(ctx, authoredSlug);
    const slugChanged = args.slug !== undefined || result.definition.slug !== authoredSlug;

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
      await setConversationWorkflowTarget(
        ctx.db,
        { tenant_id: ctx.tenant_id, conversation_id: ctx.conversation_id },
        null,
      );
    }

    if (
      args.name !== undefined ||
      slugChanged ||
      (args.input_example !== undefined && args.input_example !== null)
    ) {
      const withSample = {
        ...getWorkflowDraft(ctx.getDraft()),
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(slugChanged ? { slug: result.definition.slug } : {}),
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
        save_approval: await saveApprovalReadiness(ctx),
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
          critic: result.critic,
          ...(result.candidate_swap ? { candidate_swap: result.candidate_swap } : {}),
          persistence: "draft_only" as const,
          next_step: result.next,
          next_hint: sensitiveDefinition
            ? result.recorded_eval.ok
              ? "Run dry_run_workflow: the sensitive test run returns metadata only, never values. Then save it inactive."
              : "Apply the recorded_eval findings via edit_workflow_patch, then run the metadata-only dry_run_workflow before an inactive save."
            : result.recorded_eval.ok
              ? "Preview with dry_run_workflow — a green, judged preview auto-commits."
              : "Apply the recorded_eval findings (verified repairs ride findings[].repair.expression) via edit_workflow_patch, then dry_run_workflow.",
        },
      }),
    };
  },
};
