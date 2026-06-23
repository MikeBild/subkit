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
import { emitRecordedEvalSignals, runRecordedEval } from "../recorded-eval.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import { evaluateAuthoringStageGate } from "./authoring-stage-gate.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { getLastPreview } from "./last-preview-store.ts";
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
    "REPAIR-STAGE tool — apply a specific finding by replacing a single field on an existing step in the draft (dotted paths like `graphql.query` supported); never use it for initial authoring (that is `author_workflow`). Refuses with `authoring_stage_violation` while the draft has no recorded preview and no recorded-eval/judge findings.",
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    // Initial-stage gate (Fix A): micro-iteration is the repair flow,
    // not the authoring flow. See authoring-stage-gate.ts for the
    // predicate + deadlock-impossibility argument.
    const stageRefusal = await evaluateAuthoringStageGate(ctx, "update_param");
    if (stageRefusal) return stageRefusal;
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
    // Targeted guard: when the LLM mutates `headers` directly with a
    // JSON-encoded object STRING (e.g. `value: '{"Accept": "..."}'`)
    // the workflow schema's lenient string-coercion accepts the first
    // `{"Accept"` token as a header name, the http driver later
    // crashes inside `new Headers()` with "Invalid header name", and
    // the LLM repairs blindly through `update_param` again. Reject
    // up front with a clean repair signal so the model emits an
    // object the next turn (conversation 730c568a).
    if (args.param === "headers" && typeof args.value === "string") {
      const trimmed = args.value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return {
          ok: false,
          data: buildGateError(currentDraft, {
            error_code: "step_update_invalid",
            message:
              'headers must be an object (e.g. `{"Accept":"application/json"}`) or one or more `Name: Value` lines — a JSON-encoded string is not accepted',
            recommended_mode: "workflow",
            extra: {
              errors: [
                {
                  path: "headers",
                  message:
                    "JSON-encoded string passed where a Record<string,string> or Name:Value lines were expected",
                },
              ],
              step_id: args.step_id,
              param: args.param,
            },
          }),
        };
      }
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
    const nextDraft = withWorkflowDraft(currentDraft, workflowDraft, "workflow_step_updated");
    await ctx.setDraft(nextDraft);

    // Authoring gates (loop / transform missing-preview, hand-rolled codec)
    // are NON-blocking findings, symmetric with edit_workflow_patch: the edit
    // is accepted and the recorded-evaluation verdicts ride back in the payload
    // so the model repairs on the next call instead of thrashing through a
    // dry-run detour. The prior hard `*_requires_inspect` refusals produced 8×
    // identical retries → loop-abort in the field. No live HTTP fires here.
    const probedConnectorSlugs = await collectProbedConnectorSlugs(ctx, workflowDraft.steps);
    const lastPreview = getLastPreview({
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
    });
    const recordedEval = await runRecordedEval(workflowDraft, {
      latest_preview: nextDraft.latest_preview ?? null,
      scope: lastPreview?.scope ?? null,
      input: lastPreview?.input ?? nextDraft.latest_preview?.input ?? null,
      probedConnectorSlugs,
    });
    emitRecordedEvalSignals({
      tool: "update_param",
      conversation_id: ctx.conversation_id,
      report: recordedEval,
    });
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
          recorded_eval: recordedEval,
        },
      }),
    };
  },
};
