// update_param — replace a single field on an existing step.

import { z } from "@hono/zod-openapi";
import { recordAuthoringGateBlock } from "../../observability/instrumentation.ts";
import { buildStepDag, detectCycles, renderCycleReport } from "../../workflows/dag.ts";
import {
  validateStepReferences,
  validateUnsupportedPlaceholders,
} from "../../workflows/reference-validator.ts";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import { getWorkflowDraft, withWorkflowDraft } from "../authoring-state.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { evaluateLoopAuthoringGate } from "./loop-authoring-gate.ts";
import { collectProbedConnectorSlugs } from "./probed-connectors.ts";

const inputSchema = z
  .object({
    step_id: z.string().min(1),
    param: z.string().min(1),
    value: z.unknown(),
  })
  .openapi("UpdateParamToolInput");

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function parseParamPath(param: string): string[] {
  return param
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function applyParamPath(
  target: Record<string, unknown>,
  param: string,
  value: unknown,
): Record<string, unknown> {
  const segments = parseParamPath(param);
  if (segments.length === 0) {
    throw new Error("param must contain at least one path segment");
  }
  for (const segment of segments) {
    if (UNSAFE_PATH_SEGMENTS.has(segment)) {
      throw new Error(`param path contains forbidden segment: ${segment}`);
    }
  }
  const next = structuredClone(target);
  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const current = cursor[segment];
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      cursor = current as Record<string, unknown>;
      continue;
    }
    const created: Record<string, unknown> = {};
    cursor[segment] = created;
    cursor = created;
  }
  cursor[segments[segments.length - 1]!] = value;
  return next;
}

export const updateParamTool: ConversationTool = {
  name: "update_param",
  description:
    "Replace a single field on an existing step in the draft. Supports dotted paths like `graphql.query`.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const currentDraft = ctx.getDraft();
    const workflowDraft = structuredClone(getWorkflowDraft(currentDraft));
    const idx = workflowDraft.steps.findIndex((s) => s.id === args.step_id);
    if (idx < 0) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "unknown_step",
          message: `step not found: ${args.step_id}`,
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft"],
        }),
      };
    }
    let step: Record<string, unknown>;
    try {
      step = applyParamPath(workflowDraft.steps[idx] ?? {}, args.param, args.value);
    } catch (err) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "step_update_invalid",
          message: err instanceof Error ? err.message : String(err),
          recommended_mode: "workflow",
          extra: {
            errors: [
              {
                path: args.param,
                message: err instanceof Error ? err.message : String(err),
              },
            ],
            step_id: args.step_id,
            param: args.param,
          },
        }),
      };
    }
    workflowDraft.steps[idx] = step;
    const validation = validateWorkflowDef(workflowDraft, { allowForwardRefs: true });
    if (!validation.ok) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "step_update_invalid",
          message: "step update would leave the workflow draft invalid",
          recommended_mode: "workflow",
          extra: {
            errors: validation.errors,
            step_id: args.step_id,
            param: args.param,
          },
        }),
      };
    }

    // Same authoring-time gates as build_workflow / propose_step /
    // edit_workflow_patch. Pre-fix update_param was the LLM's
    // single-field escape hatch — it could re-introduce a cycle, a
    // bad reference, or an inspect-less loop without the engine
    // catching it until the next dry-run.
    {
      // biome-ignore lint/suspicious/noExplicitAny: structurally compatible
      const dag = buildStepDag(workflowDraft as any);
      const cycleReport = detectCycles(dag);
      if (cycleReport.has_cycle) {
        recordAuthoringGateBlock({ code: "workflow_cycle_detected", tool: "update_param" });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "workflow_cycle_detected",
            message: `update would introduce a cyclic step dependency: ${renderCycleReport(cycleReport)}`,
            recommended_mode: "workflow",
            next_best_actions: ["inspect_workflow_draft", "edit_workflow_patch"],
            extra: {
              cycles: cycleReport.cycles,
              step_id: args.step_id,
              param: args.param,
            },
          }),
        };
      }
    }
    {
      // biome-ignore lint/suspicious/noExplicitAny: structurally compatible
      const placeholderErrors = validateUnsupportedPlaceholders(workflowDraft as any);
      if (placeholderErrors.length > 0) {
        const summary = placeholderErrors
          .map(
            (e) =>
              `step \`${e.step_id}\`.${e.field}: \`${e.raw}\` (${e.code}) → use \`${e.did_you_mean}\``,
          )
          .join("; ");
        recordAuthoringGateBlock({
          code: "workflow_unsupported_placeholder",
          tool: "update_param",
        });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "workflow_unsupported_placeholder",
            message: `update would leave placeholder forms the runtime will not substitute: ${summary}`,
            recommended_mode: "workflow",
            next_best_actions: [
              "inspect_workflow_draft",
              "suggest_jsonata_paths",
              "edit_workflow_patch",
            ],
            extra: {
              unsupported_placeholders: placeholderErrors,
              step_id: args.step_id,
              param: args.param,
            },
          }),
        };
      }
    }
    {
      // biome-ignore lint/suspicious/noExplicitAny: structurally compatible
      const refErrors = validateStepReferences(workflowDraft as any);
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
          tool: "update_param",
        });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "workflow_unresolved_step_reference",
            message: `update would leave unresolved step references: ${summary}`,
            recommended_mode: "workflow",
            next_best_actions: [
              "inspect_workflow_draft",
              "suggest_jsonata_paths",
              "edit_workflow_patch",
            ],
            extra: {
              unresolved_references: refErrors,
              step_id: args.step_id,
              param: args.param,
            },
          }),
        };
      }
    }
    {
      // Loop-authoring gate. Refine: only enforce when the EDITED
      // step is the loop being authored AND the param being mutated
      // is `over` / `data_selector` (the only fields that introduce a
      // new $scope reference). Pre-fix this gate fired for every
      // update_param against a workflow that had any loop step,
      // including param edits that didn't touch the loop at all —
      // making update_param unusable as the documented fix path for
      // a prior loop_authoring_requires_inspect rejection.
      const editedStepIsLoop = typeof step.kind === "string" && step.kind === "loop";
      const paramTouchesLoopSource =
        args.param === "over" ||
        args.param === "data_selector" ||
        args.param.startsWith("over.") ||
        args.param.startsWith("data_selector.");
      const gateIsRelevant = editedStepIsLoop && paramTouchesLoopSource;
      const probedConnectorSlugs = gateIsRelevant
        ? await collectProbedConnectorSlugs(ctx, workflowDraft.steps)
        : new Set<string>();
      const gate = gateIsRelevant
        ? evaluateLoopAuthoringGate(workflowDraft, currentDraft.latest_preview ?? null, {
            probedConnectorSlugs,
          })
        : { ok: true as const, blocks: [] };
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
          tool: "update_param",
        });
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "loop_authoring_requires_inspect",
            message: `update would leave a loop step depending on data the upstream preview never recorded. ${summary}. Dry-run once so the scope is published, then re-apply.`,
            recommended_mode: "workflow",
            next_best_actions: [
              "dry_run_workflow",
              "inspect_workflow_draft",
              "suggest_jsonata_paths",
            ],
            extra: {
              gate_blocks: gate.blocks,
              step_id: args.step_id,
              param: args.param,
            },
          }),
        };
      }
    }

    const nextDraft = withWorkflowDraft(currentDraft, workflowDraft, "workflow_step_updated");
    await ctx.setDraft(nextDraft);
    return {
      ok: true,
      data: buildDraftMutationPayload(nextDraft, {
        resource_kind: "workflow",
        extra: {
          step_id: args.step_id,
          param: args.param,
          steps: workflowDraft.steps.length,
          step_type: typeof step.kind === "string" ? step.kind : null,
          last_step_id: workflowDraft.steps[workflowDraft.steps.length - 1]?.id ?? null,
        },
      }),
    };
  },
};
