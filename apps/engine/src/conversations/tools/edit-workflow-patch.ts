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
import { emitRecordedEvalSignals, runRecordedEval } from "../recorded-eval.ts";
import { stepFingerprint } from "../step-fingerprint.ts";
import { canonicalJson } from "../text-line-diff.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { getLastPreview } from "./last-preview-store.ts";
import { collectProbedConnectorSlugs } from "./probed-connectors.ts";

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

    // Rename-aware evidence carry-over. A `replace /steps/N/id` rename
    // does not change the step's recorded shape — only its address.
    // Remap the trace's `step_id` AND recompute its fingerprint against
    // the renamed definition so the fingerprint-keyed pruning in
    // `withWorkflowDraft` (Fix 5) keeps the evidence: an atomic
    // rename + retarget must not cost a redundant dry-run. If the patch
    // also changed other fields of the renamed step, the recomputed
    // fingerprint won't match the patched step and the evidence drops —
    // exactly the retention contract.
    const renamedStepIds = new Map<string, string>();
    for (let i = 0; i < args.patches.length; i++) {
      const op = args.patches[i]!;
      if (op.op !== "replace") continue;
      const match = /^\/steps\/(\d+)\/id$/.exec(op.path);
      if (!match) continue;
      const idx = Number(match[1]);
      const preStep = workflowDraft.steps[idx];
      const preId = typeof preStep?.id === "string" ? preStep.id : null;
      const nextId = typeof op.value === "string" ? op.value : null;
      if (preId && nextId && preId !== nextId) {
        renamedStepIds.set(preId, nextId);
      }
    }
    const preStepById = new Map<string, Record<string, unknown>>();
    for (const step of workflowDraft.steps) {
      if (typeof step.id === "string") preStepById.set(step.id, step);
    }
    const remappedPreview: typeof currentDraft.latest_preview =
      currentDraft.latest_preview && renamedStepIds.size > 0
        ? {
            ...currentDraft.latest_preview,
            step_traces: (currentDraft.latest_preview.step_traces ?? []).map((t) => {
              const nextId = renamedStepIds.get(t.step_id);
              if (!nextId) return t;
              const preStep = preStepById.get(t.step_id);
              return {
                ...t,
                step_id: nextId,
                ...(preStep && typeof t.fingerprint === "string"
                  ? { fingerprint: stepFingerprint({ ...preStep, id: nextId }) }
                  : {}),
              };
            }),
          }
        : (currentDraft.latest_preview ?? null);

    const beforeJson = canonicalJson(workflowDraft);
    const draftForMutation =
      remappedPreview !== (currentDraft.latest_preview ?? null)
        ? { ...currentDraft, latest_preview: remappedPreview }
        : currentDraft;
    const nextDraft = withWorkflowDraft(draftForMutation, patched, "workflow_step_updated");
    await ctx.setDraft(nextDraft);
    if (ctx.emitDiff) {
      ctx.emitDiff({
        title: `workflow patch · ${args.patches.length} ${args.patches.length === 1 ? "op" : "ops"}`,
        language: "json",
        before: beforeJson,
        after: canonicalJson(patched),
      });
    }

    // Recorded-evaluation pass (Fix 9). The loop/transform authoring
    // gates used to refuse a patch that INTRODUCED an un-previewed
    // scope reference; the patch is accepted now and the same gate
    // verdicts — plus compile caret errors and evaluation against
    // fingerprint-valid recorded evidence — return as findings so the
    // model repairs in the next call instead of thrashing through a
    // dry-run detour. No live HTTP fires here.
    const probedConnectorSlugs = await collectProbedConnectorSlugs(
      ctx,
      patched.steps as ReadonlyArray<Record<string, unknown>>,
    );
    const lastPreview = getLastPreview({
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
    });
    const recordedEval = await runRecordedEval(patched, {
      latest_preview: nextDraft.latest_preview ?? null,
      scope: lastPreview?.scope ?? null,
      input: lastPreview?.input ?? nextDraft.latest_preview?.input ?? null,
      probedConnectorSlugs,
    });
    emitRecordedEvalSignals({
      tool: "edit_workflow_patch",
      conversation_id: ctx.conversation_id,
      report: recordedEval,
    });
    return {
      ok: true,
      data: buildDraftMutationPayload(nextDraft, {
        resource_kind: "workflow",
        extra: {
          patch_count: args.patches.length,
          steps: patched.steps.length,
          last_step_id: patched.steps[patched.steps.length - 1]?.id ?? null,
          recorded_eval: recordedEval,
        },
      }),
    };
  },
};
