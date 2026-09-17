// edit_workflow_patch — THE workflow editor. An RFC 6902 JSON Patch
// over the entire workflow draft in one call. It expresses every
// targeted change: append/replace a step (`add /steps/-`,
// `replace /steps/N`), set a single field or header
// (`replace /steps/N/headers/Accept`), retarget references, add an edge
// (`add /edges/-`), or reorder steps (`move`). Coordinated multi-edits
// (rename a step + retarget every reference + change one URL) land
// atomically instead of over N round-trips.
//
// The applied patch must produce a draft that still validates against
// the WorkflowDef Zod schema. The patch fails atomically — if any
// operation throws, the draft is left untouched.

import { z } from "@hono/zod-openapi";
import { recordAuthoringGateBlock } from "../../observability/instrumentation.ts";
import { buildStepDag, detectCycles, renderCycleReport } from "../../workflows/dag.ts";
import {
  type ItemvarRewriteChange,
  rewriteWorkflowItemVars,
} from "../../workflows/itemvar-rewrite.ts";
import {
  validateStepReferences,
  validateUnsupportedPlaceholders,
} from "../../workflows/reference-validator.ts";
import { type WorkflowDef, WorkflowDefSchema } from "../../workflows/types.ts";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import { getWorkflowDraft, withWorkflowDraft } from "../authoring-state.ts";
import { applyDiffsToConfig, type ToolDiff } from "../json-patch-apply.ts";
import { emitRecordedEvalSignals, runRecordedEval } from "../recorded-eval.ts";
import { stepFingerprint } from "../step-fingerprint.ts";
import { canonicalJson } from "../text-line-diff.ts";
import { buildDraftMutationPayload, buildGateError } from "./authoring-contract.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";
import { getLastPreview } from "./last-preview-store.ts";
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
    patches: z.array(PatchOp).min(1).max(64).optional(),
    step_patches: z.array(StepPatchSchema).min(1).max(64).optional(),
  })
  .refine(
    (value) => Boolean(value.patches) !== Boolean(value.step_patches),
    "Provide exactly one of patches or step_patches",
  )
  .openapi("EditWorkflowPatchToolInput");

export const editWorkflowPatchTool: ConversationTool = {
  name: "edit_workflow_patch",
  description:
    "THE workflow editor. Prefer step_patches for edits inside existing top-level steps: each entry has step_id, op, path relative to that step (e.g. /s3/scope), and value for add/replace/test. The server resolves stable IDs against the current draft; never count step indices. Do not mix step_patches with patches. Apply an RFC 6902 JSON Patch array to the workflow draft: append/replace a step (`add /steps/-`, `replace /steps/N`), set a single field or header (`replace /steps/N/headers/Accept`), retarget references, add an edge (`add /edges/-`), or reorder steps (`move`). Coordinated multi-edits land atomically. The patched draft must still validate; partial application is never persisted.",
  inputSchema,
  category: "draft_write" as const,
  authoring_resource: "workflow",
  requires_draft: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
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
          message: error instanceof Error ? error.message : "Invalid step target",
          next_best_actions: ["inspect_workflow_draft"],
        }),
      };
    }
    return applyWorkflowPatchToDraft(ctx, patches);
  },
};

/**
 * THE draft-patch application core, extracted so both the LLM-driven
 * `edit_workflow_patch` tool AND the harness partial-accept dispatcher
 * (`apply_workflow_patch` commit_intent) share ONE gate chain + one
 * durability contract. Applies the RFC-6902 `patches` to the workflow
 * draft, runs every pre-flight gate (validation, cycle, placeholder,
 * reference, legacy item_var migration), commits the patched draft, and
 * returns the recorded-eval findings. The patch fails atomically — an
 * invalid patch leaves the draft untouched.
 *
 * Partial-accept feeds a SUBSET of the originally-proposed ops here, so the
 * subset is re-validated as a standalone patch: a rename accepted without
 * its retarget correctly returns `workflow_unresolved_step_reference`
 * instead of silently landing a broken draft.
 */
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
      // fast-json-patch throws on invalid path / wrong op semantics.
      // Surface the message so the LLM can correct without re-reading
      // the whole draft.
      return {
        ok: false,
        data: buildGateError(currentDraft, {
          error_code: "patch_invalid",
          message: `${(err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 300)}. The draft remains editable in this conversation. Inspect the actual step index and fields; do not infer a missing mode or permission from an invalid JSON path.`,
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft"],
          extra: {
            patches: patches.map(({ op, path }) => ({ op, path })),
            step_paths: (workflowDraft.steps ?? []).map((step, index) => ({
              id: step.id,
              path: `/steps/${index}`,
              fields: Object.keys(step),
              ...(step.kind === "request" && step.s3
                ? {
                    s3_fields: Object.keys(step.s3),
                    storage_scope_path: `/steps/${index}/s3/scope`,
                  }
                : {}),
            })),
            repair_hint:
              "Use step_patches with step_id and a relative path to avoid positional guesses. Use existing fields directly under each step, without a config wrapper. For S3 recurring boundaries use s3.scope with key_prefix and max_bytes, never path_prefix. Inspect the relevant step before patching; no external setup is required.",
          },
        }),
      };
    }

    // Legacy item_var auto-migration (Chat-First contract): a workflow
    // loaded for editing may still carry the retired `item_var` contract
    // (the boot backfill leaves unprovable rewrites untouched). Rather
    // than bouncing EVERY edit with "item_var is retired", run the
    // PROVEN AST rewriter in-band: a provable rewrite is applied and
    // reported; an unprovable one earns a typed error naming the manual
    // step — the user can always edit their own workflow from chat.
    // A patch may legally target `steps`, and nothing upstream guarantees the
    // op left an ARRAY behind — `applyDiffsToConfig` applies what it is given.
    // `?? []` only covers null/undefined, so a `replace` that put an object
    // there reached `.some()` and threw a raw TypeError
    // ("(patched.steps ?? []).some is not a function"), escaping as an
    // untyped crash instead of something the model could correct. Observed in
    // production right after an in-band tool-call repair fed corrected args
    // back into the loop. Fail the patch atomically, in the shape every other
    // bad patch already uses.
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

    let legacyItemvarChanges: ItemvarRewriteChange[] | null = null;
    const declaresItemvar = (patched.steps ?? []).some(
      (st) =>
        typeof st === "object" &&
        st !== null &&
        (st as { kind?: unknown }).kind === "loop" &&
        typeof (st as { item_var?: unknown }).item_var === "string",
    );
    if (declaresItemvar) {
      const parsedLegacy = WorkflowDefSchema.safeParse(patched);
      if (parsedLegacy.success) {
        const rewrite = rewriteWorkflowItemVars(parsedLegacy.data);
        if (rewrite.ok) {
          patched = { ...patched, steps: rewrite.def.steps } as typeof patched;
          legacyItemvarChanges = rewrite.changes;
        } else {
          recordAuthoringGateBlock({
            code: "legacy_itemvar_migration_required",
            tool: "edit_workflow_patch",
          });
          return {
            ok: false,
            data: buildGateError(currentDraft, {
              error_code: "legacy_itemvar_migration_required",
              message: `this workflow still uses the retired item_var loop contract and the automatic $item rewrite could not be PROVEN equivalent (${rewrite.reason}) — rewrite the affected loop-body expressions to $item manually (include the change in your patch), then retry`,
              recommended_mode: "workflow",
              next_best_actions: ["inspect_workflow_draft", "edit_workflow_patch"],
              extra: {
                reason: rewrite.reason,
                ...(rewrite.step_id ? { step_id: rewrite.step_id } : {}),
                ...(rewrite.field ? { field: rewrite.field } : {}),
              },
            }),
          };
        }
      }
    }

    // Unsupported-placeholder pre-flight BEFORE the structural validator:
    // validateWorkflowDef also parses placeholder grammar on addressing
    // surfaces (audit M4) and would otherwise report e.g. `${user.email}`
    // as a generic `patch_invalid`, shadowing the specific error code +
    // did-you-mean the model's recovery hints key on. Runs on the RAW
    // patched object; guarded because the draft may not even have a
    // steps array yet — the structural validator below reports that case.
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
            },
          }),
        };
      }
    }

    const validation = validateWorkflowDef(patched, { allowForwardRefs: true });
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
          },
        }),
      };
    }

    // Cycle pre-flight on the patched draft. Reject patches that would
    // introduce a cyclic step dependency — same typed error code +
    // shape as author_workflow / dry_run_workflow so the LLM has a
    // single contract to obey.
    {
      // The draft is a WorkflowDef here: validateWorkflowDef just parsed it
      // successfully above. The gates run on the RAW draft object (not the
      // Zod-stripped parse result) so unknown-key placeholders still scan.
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

    // Reference pre-flight on the patched draft.
    {
      const refErrors = validateStepReferences(patched as WorkflowDef);
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
            next_best_actions: ["inspect_workflow_draft"],
            extra: {
              unresolved_references: refErrors,
              patch_count: patches.length,
            },
          }),
        };
      }
    }

    // Rename-aware evidence carry-over. A `replace /steps/N/id` rename
    // does not change the step's recorded shape — only its address.
    // Remap the trace's `step_id` AND recompute its fingerprint against
    // the renamed definition so the fingerprint-keyed pruning in
    // `withWorkflowDraft` keeps the evidence: an atomic
    // rename + retarget must not cost a redundant dry-run. If the patch
    // also changed other fields of the renamed step, the recomputed
    // fingerprint won't match the patched step and the evidence drops —
    // exactly the retention contract.
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

    // Recorded-evaluation pass. The loop/transform authoring
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
          patch_count: patches.length,
          steps: patched.steps.length,
          last_step_id: patched.steps[patched.steps.length - 1]?.id ?? null,
          recorded_eval: recordedEval,
          ...(legacyItemvarChanges
            ? {
                legacy_itemvar_migrated: true,
                itemvar_changes: legacyItemvarChanges,
              }
            : {}),
        },
      }),
    };
  }
}
