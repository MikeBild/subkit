import { z } from "@hono/zod-openapi";
import { recordAuthoringGateBlock } from "../../observability/instrumentation.ts";
import { buildStepDag, detectCycles, renderCycleReport } from "../../workflows/dag.ts";
import { validateTenantWorkflowDef } from "../../workflows/index.ts";
import {
  describeStepReferences,
  validateUnsupportedPlaceholders,
} from "../../workflows/reference-validator.ts";
import type { WorkflowDef } from "../../workflows/types.ts";
import { persistedWorkflowResource } from "../authoring-state/summary.ts";
import { getWorkflowDraft, withWorkflowDraft } from "../authoring-state.ts";
import { applyDiffsToConfig, type ToolDiff } from "../json-patch-apply.ts";
import { emitRecordedEvalSignals, runRecordedEval } from "../recorded-eval.ts";
import { stepFingerprint } from "../step-fingerprint.ts";
import { canonicalJson } from "../text-line-diff.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";
import { classifyStepReferences } from "./inherited-step-references.ts";
import { getLastPreview } from "./last-preview-store.ts";
import { boundWorkflowIdOf } from "./open-workflow-draft.ts";
import { collectProbedConnectorSlugs } from "./probed-connectors.ts";
import { resolveStepPatches, StepPatchSchema } from "./step-targeted-patch.ts";

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
    workflow: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Slug or id of the workflow this patch is meant for. The patch is refused with draft_target_mismatch when the draft belongs to another workflow.",
      ),
    patches: z.array(PatchOp).min(1).max(64).optional(),
    step_patches: z.array(StepPatchSchema).min(1).max(64).optional(),
  })
  .refine(
    (value) => Boolean(value.patches) !== Boolean(value.step_patches),
    "Provide exactly one of patches or step_patches",
  )
  .openapi("EditWorkflowPatchToolInput");

function repairExtras(draft: { steps?: Array<Record<string, unknown>> }): Record<string, unknown> {
  return {
    step_paths: (draft.steps ?? []).map((step, index) => ({
      id: step.id,
      path: `/steps/${index}`,
      fields: Object.keys(step),
      ...(step.kind === "request" && step.s3
        ? {
            s3_fields: Object.keys(step.s3 as Record<string, unknown>),
            storage_scope_path: `/steps/${index}/s3/scope`,
          }
        : {}),
    })),
    repair_hint:
      "Use step_patches with step_id and a relative path to avoid positional guesses. Use existing fields directly under each step, without a config wrapper. For S3 recurring boundaries use s3.scope with key_prefix and max_bytes, plus max_deletes for a DELETE step, never path_prefix; s3.max_keys and s3.paginate are derived from the step and are not author-set per-prefix limits, so never template them. For an HTTP step with a runtime placeholder in its path or body, add `boundary` directly on the step (path `/boundary`) with variables, max_body_bytes and max_calls. Inspect the relevant step before patching; no external setup is required.",
  };
}

interface DraftTarget {
  workflow_id: string | null;
  slug: string | null;
  saved_slug: string | null;
  name: string | null;
}

export function draftTargetOf(ctx: ToolContext): DraftTarget {
  const draft = ctx.getDraft();
  const bound = draft.state ? persistedWorkflowResource(draft.state) : null;
  const workflowId = boundWorkflowIdOf(ctx);
  return {
    workflow_id: workflowId,
    slug: draft.workflow?.slug ?? bound?.slug ?? null,
    saved_slug: bound?.id === workflowId ? (bound?.slug ?? null) : null,
    name: draft.workflow?.name || bound?.name || null,
  };
}

function targetMatches(target: DraftTarget, ref: string): boolean {
  return ref === target.workflow_id || ref === target.slug || ref === target.saved_slug;
}

export const editWorkflowPatchTool: ConversationTool = {
  name: "edit_workflow_patch",
  description:
    "THE workflow editor for the workflow the conversation's draft holds; pass that workflow's slug as `workflow` so a patch meant for another workflow is refused instead of applied — switch with open_workflow_draft. Prefer step_patches for edits inside existing top-level steps: each entry has step_id, op, path relative to that step (e.g. /s3/scope), and value for add/replace/test. The server resolves stable IDs against the current draft; never count step indices. Do not mix step_patches with patches. Apply an RFC 6902 JSON Patch array to the workflow draft: append/replace a step (`add /steps/-`, `replace /steps/N`), set a single field or header (`replace /steps/N/headers/Accept`), retarget references, add an edge (`add /edges/-`), or reorder steps (`move`). Coordinated multi-edits land atomically. The patched draft must still validate; partial application is never persisted.",
  inputSchema,
  category: "draft_write" as const,
  authoring_resource: "workflow",
  requires_draft: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const target = draftTargetOf(ctx);
    if (args.workflow !== undefined && !targetMatches(target, args.workflow)) {
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: "draft_target_mismatch",
          message: `the patch is meant for "${args.workflow}", but this conversation's draft is workflow "${target.slug ?? target.workflow_id ?? target.name ?? "(unnamed)"}". Nothing was changed. Open "${args.workflow}" with open_workflow_draft first, then patch it.`,
          recommended_mode: "workflow",
          next_best_actions: ["open_workflow_draft"],
          extra: { target, requested_workflow: args.workflow },
        }),
      };
    }
    let patches: ToolDiff[];
    try {
      patches = args.step_patches
        ? resolveStepPatches(getWorkflowDraft(ctx.getDraft()).steps ?? [], args.step_patches)
        : (args.patches as ToolDiff[]);
    } catch (error) {
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: "patch_target_invalid",
          message: `${error instanceof Error ? error.message : "Invalid step target"} (in the draft of workflow "${target.slug ?? target.workflow_id ?? target.name ?? "(unnamed)"}")`,
          next_best_actions: ["inspect_workflow_draft", "open_workflow_draft"],
          extra: { target },
        }),
      };
    }
    return applyWorkflowPatchToDraft(ctx, patches);
  },
};

export async function applyWorkflowPatchToDraft(
  ctx: ToolContext,
  patches: ToolDiff[],
): Promise<ToolResult> {
  {
    const currentDraft = ctx.getDraft();
    const workflowDraft = getWorkflowDraft(currentDraft);

    let patched: ReturnType<typeof getWorkflowDraft>;
    try {
      patched = applyDiffsToConfig(workflowDraft, patches);
    } catch (err) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "patch_invalid",
          message: `${(err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 300)}. The draft remains editable in this conversation. Inspect the actual step index and fields; do not infer a missing mode or permission from an invalid JSON path.`,
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft"],
          extra: {
            patches: patches.map(({ op, path }) => ({ op, path })),
            ...repairExtras(workflowDraft),
          },
        }),
      };
    }

    if (patched.steps !== undefined && !Array.isArray(patched.steps)) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "patch_invalid",
          message: `the patch left \`steps\` as ${patched.steps === null ? "null" : typeof patched.steps}, not an array — steps must stay a list of step objects`,
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft"],
          extra: { patches },
        }),
      };
    }

    if (Array.isArray((patched as WorkflowDef).steps)) {
      const placeholderErrors = validateUnsupportedPlaceholders(patched as WorkflowDef);
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
            next_best_actions: ["inspect_workflow_draft"],
            extra: {
              unsupported_placeholders: placeholderErrors,
              patch_count: patches.length,
              ...repairExtras(currentDraft.workflow ?? {}),
            },
          }),
        };
      }
    }

    const validation = await validateTenantWorkflowDef(patched, ctx.tenant_id, ctx.db, {
      allowForwardRefs: true,
    });
    if (!validation.ok) {
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "patch_invalid",
          message: "patch would leave the workflow draft invalid",
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft"],
          extra: {
            errors: validation.errors,
            patch_count: patches.length,
            ...repairExtras(currentDraft.workflow ?? {}),
          },
        }),
      };
    }

    {
      const dag = buildStepDag(patched as WorkflowDef);
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
            next_best_actions: ["inspect_workflow_draft"],
            extra: {
              cycles: cycleReport.cycles,
              patch_count: patches.length,
            },
          }),
        };
      }
    }

    const references = await classifyStepReferences(
      ctx,
      "edit_workflow_patch",
      patched as WorkflowDef,
    );
    if (references.introduced.length > 0) {
      recordAuthoringGateBlock({
        code: "workflow_unresolved_step_reference",
        tool: "edit_workflow_patch",
      });
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "workflow_unresolved_step_reference",
          message: `patch would leave unresolved step references: ${describeStepReferences(references.introduced)}`,
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft"],
          extra: {
            unresolved_references: references.introduced,
            patch_count: patches.length,
            ...(references.notice ? { inherited_step_references: references.notice } : {}),
          },
        }),
      };
    }

    const renamedStepIds = new Map<string, string>();
    for (let i = 0; i < patches.length; i++) {
      const op = patches[i]!;
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
        title: `workflow patch · ${patches.length} ${patches.length === 1 ? "op" : "ops"}`,
        language: "json",
        before: beforeJson,
        after: canonicalJson(patched),
      });
    }

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
          target: draftTargetOf(ctx),
          patch_count: patches.length,
          ...(references.notice ? { inherited_step_references: references.notice } : {}),
          steps: patched.steps.length,
          last_step_id: patched.steps[patched.steps.length - 1]?.id ?? null,
          recorded_eval: recordedEval,
        },
      }),
    };
  }
}
