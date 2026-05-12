// edit_workflow_patch — RFC 6902 JSON Patch over the entire workflow
// draft in one call. Mirrors the reference impl's `edit_tool` payload.
// `update_param` already supports a single-field write; this tool is
// for coordinated multi-edits (rename a step + retarget every
// reference + change one URL) where N round-trips would be wasteful.
//
// The applied patch must produce a draft that still validates against
// the WorkflowDef Zod schema. The patch fails atomically — if any
// operation throws, the draft is left untouched.

import { z } from "@hono/zod-openapi";
import { recordAuthoringGateBlock } from "../../observability/instrumentation.ts";
import { buildStepDag, detectCycles, renderCycleReport } from "../../workflows/dag.ts";
import {
  validateStepReferences,
  validateUnsupportedPlaceholders,
} from "../../workflows/reference-validator.ts";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import { getWorkflowDraft, withWorkflowDraft } from "../authoring-state.ts";
import { applyDiffsToConfig, type ToolDiff } from "../json-patch-apply.ts";
import { canonicalJson } from "../text-line-diff.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { evaluateLoopAuthoringGate } from "./loop-authoring-gate.ts";
import { collectProbedConnectorSlugs } from "./probed-connectors.ts";
import { evaluateTransformAuthoringGate } from "./transform-authoring-gate.ts";

const PatchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: z.string() }),
  z.object({ op: z.literal("replace"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("move"), path: z.string(), from: z.string() }),
  z.object({ op: z.literal("copy"), path: z.string(), from: z.string() }),
  z.object({ op: z.literal("test"), path: z.string(), value: z.unknown() }),
]);

const inputSchema = z
  .object({
    patches: z.array(PatchOp).min(1).max(64),
  })
  .openapi("EditWorkflowPatchToolInput");

export const editWorkflowPatchTool: ConversationTool = {
  name: "edit_workflow_patch",
  description:
    "Apply an RFC 6902 JSON Patch array to the workflow draft. Use for coordinated multi-edits (rename + retarget refs + change config) — for single-field writes, prefer `update_param`. The patched draft must still validate; partial application is never persisted.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const currentDraft = ctx.getDraft();
    const workflowDraft = getWorkflowDraft(currentDraft);

    let patched: ReturnType<typeof getWorkflowDraft>;
    try {
      patched = applyDiffsToConfig(workflowDraft, args.patches as ToolDiff[]);
    } catch (err) {
      // fast-json-patch throws on invalid path / wrong op semantics.
      // Surface the message so the LLM can correct without re-reading
      // the whole draft.
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "patch_invalid",
          message: err instanceof Error ? err.message : String(err),
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft", "update_param"],
          extra: {
            patches: args.patches,
          },
        }),
      };
    }

    const validation = validateWorkflowDef(patched, { allowForwardRefs: true });
    if (!validation.ok) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "patch_invalid",
          message: "patch would leave the workflow draft invalid",
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft", "update_param"],
          extra: {
            errors: validation.errors,
            patch_count: args.patches.length,
          },
        }),
      };
    }

    // Cycle pre-flight on the patched draft. Reject patches that would
    // introduce a cyclic step dependency — same typed error code +
    // shape as build_workflow / dry_run_workflow so the LLM has a
    // single contract to obey.
    {
      // biome-ignore lint/suspicious/noExplicitAny: WorkflowDraftDocument structurally compatible with WorkflowDef
      const dag = buildStepDag(patched as any);
      const cycleReport = detectCycles(dag);
      if (cycleReport.has_cycle) {
        recordAuthoringGateBlock({
          code: "workflow_cycle_detected",
          tool: "edit_workflow_patch",
        });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "workflow_cycle_detected",
            message: `patch would introduce a cyclic step dependency: ${renderCycleReport(cycleReport)}`,
            recommended_mode: "workflow",
            next_best_actions: ["inspect_workflow_draft", "update_param"],
            extra: {
              cycles: cycleReport.cycles,
              patch_count: args.patches.length,
            },
          }),
        };
      }
    }

    // Unsupported-placeholder pre-flight on the patched draft.
    {
      // biome-ignore lint/suspicious/noExplicitAny: WorkflowDraftDocument structurally compatible
      const placeholderErrors = validateUnsupportedPlaceholders(patched as any);
      if (placeholderErrors.length > 0) {
        const summary = placeholderErrors
          .map(
            (e) =>
              `step \`${e.step_id}\`.${e.field}: \`${e.raw}\` (${e.code}) → use \`${e.did_you_mean}\``,
          )
          .join("; ");
        recordAuthoringGateBlock({
          code: "workflow_unsupported_placeholder",
          tool: "edit_workflow_patch",
        });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "workflow_unsupported_placeholder",
            message: `patch would leave placeholder forms the runtime will not substitute: ${summary}`,
            recommended_mode: "workflow",
            next_best_actions: ["inspect_workflow_draft", "update_param"],
            extra: {
              unsupported_placeholders: placeholderErrors,
              patch_count: args.patches.length,
            },
          }),
        };
      }
    }

    // Reference pre-flight on the patched draft.
    {
      // biome-ignore lint/suspicious/noExplicitAny: WorkflowDraftDocument structurally compatible
      const refErrors = validateStepReferences(patched as any);
      if (refErrors.length > 0) {
        const summary = refErrors
          .map(
            (e) =>
              `step \`${e.step_id}\`.${e.field} → unknown step \`${e.bad_reference}\`` +
              (e.did_you_mean.length > 0
                ? ` (did you mean: ${e.did_you_mean.map((s) => `\`${s}\``).join(", ")})`
                : ""),
          )
          .join("; ");
        recordAuthoringGateBlock({
          code: "workflow_unresolved_step_reference",
          tool: "edit_workflow_patch",
        });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "workflow_unresolved_step_reference",
            message: `patch would leave unresolved step references: ${summary}`,
            recommended_mode: "workflow",
            next_best_actions: ["inspect_workflow_draft", "update_param"],
            extra: {
              unresolved_references: refErrors,
              patch_count: args.patches.length,
            },
          }),
        };
      }
    }

    // Transform-authoring inspection gate on the patched draft. Refuse
    // a patch that introduces (or now contains) a transform whose
    // expression reads `$scope.<X>` without a recorded preview for X.
    // Catches the case where a patch modifies a transform's expression
    // to reference fields the upstream step never exposed.
    {
      const gate = evaluateTransformAuthoringGate(patched, currentDraft.latest_preview ?? null);
      if (!gate.ok) {
        const summary = gate.blocks
          .map(
            (b) =>
              `transform \`${b.transform_step_id}\` reads \`$scope.${b.referenced_step_id}\` but ${
                b.reason === "no_dry_run_yet"
                  ? "no dry-run has been recorded yet"
                  : `\`${b.referenced_step_id}\` has no recent preview`
              }`,
          )
          .join("; ");
        recordAuthoringGateBlock({
          code: "transform_authoring_requires_inspect",
          tool: "edit_workflow_patch",
        });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "transform_authoring_requires_inspect",
            message: `patch would leave a transform step depending on data the upstream preview never recorded. ${summary}. Dry-run once so the scope is published, then re-apply the patch.`,
            recommended_mode: "workflow",
            next_best_actions: [
              "dry_run_workflow",
              "inspect_workflow_draft",
              "suggest_jsonata_paths",
            ],
            extra: {
              gate_blocks: gate.blocks,
              patch_count: args.patches.length,
            },
          }),
        };
      }
    }

    // Loop-authoring inspection gate on the patched draft. Refuse a
    // patch that introduces (or now contains) a loop reading
    // `$scope.<X>` without a recorded preview for X.
    {
      const probedConnectorSlugs = await collectProbedConnectorSlugs(
        ctx,
        patched.steps as ReadonlyArray<Record<string, unknown>>,
      );
      const gate = evaluateLoopAuthoringGate(patched, currentDraft.latest_preview ?? null, {
        probedConnectorSlugs,
      });
      if (!gate.ok) {
        const summary = gate.blocks
          .map(
            (b) =>
              `loop \`${b.loop_step_id}\` reads \`$scope.${b.referenced_step_id}\` but ${
                b.reason === "no_dry_run_yet"
                  ? "no dry-run has been recorded yet"
                  : b.reason === "no_preview_for_referenced_step"
                    ? `\`${b.referenced_step_id}\` has no recent preview`
                    : `the recorded preview for \`${b.referenced_step_id}\` doesn't include a scope summary`
              }`,
          )
          .join("; ");
        recordAuthoringGateBlock({
          code: "loop_authoring_requires_inspect",
          tool: "edit_workflow_patch",
        });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "loop_authoring_requires_inspect",
            message: `patch would leave a loop step depending on data the upstream preview never recorded. ${summary}. Dry-run once so the scope is published, then re-apply the patch.`,
            recommended_mode: "workflow",
            next_best_actions: [
              "dry_run_workflow",
              "inspect_workflow_draft",
              "suggest_jsonata_paths",
            ],
            extra: {
              gate_blocks: gate.blocks,
              patch_count: args.patches.length,
            },
          }),
        };
      }
    }

    const beforeJson = canonicalJson(workflowDraft);
    const nextDraft = withWorkflowDraft(currentDraft, patched, "workflow_step_updated");
    await ctx.setDraft(nextDraft);
    if (ctx.emitDiff) {
      ctx.emitDiff({
        title: `workflow patch · ${args.patches.length} ${args.patches.length === 1 ? "op" : "ops"}`,
        language: "json",
        before: beforeJson,
        after: canonicalJson(patched),
      });
    }
    return {
      ok: true,
      data: buildDraftMutationPayload(nextDraft, {
        resource_kind: "workflow",
        extra: {
          patch_count: args.patches.length,
          steps: patched.steps.length,
          last_step_id: patched.steps[patched.steps.length - 1]?.id ?? null,
        },
      }),
    };
  },
};
