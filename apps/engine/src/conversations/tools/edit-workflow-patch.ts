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
import { WorkflowDefSchema } from "../../workflows/types.ts";
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
    "THE workflow editor. Apply an RFC 6902 JSON Patch array to the workflow draft: append/replace a step (`add /steps/-`, `replace /steps/N`), set a single field or header (`replace /steps/N/headers/Accept`), retarget references, add an edge (`add /edges/-`), or reorder steps (`move`). Coordinated multi-edits land atomically. The patched draft must still validate; partial application is never persisted.",
  inputSchema,
  category: "draft_write" as const,
  requires_draft: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    return applyWorkflowPatchToDraft(ctx, args.patches as ToolDiff[]);
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
          message: err instanceof Error ? err.message : String(err),
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft"],
          extra: {
            patches,
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
            next_best_actions: ["inspect_workflow_draft"],
            extra: {
              cycles: cycleReport.cycles,
              patch_count: patches.length,
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
            next_best_actions: ["inspect_workflow_draft"],
            extra: {
              unsupported_placeholders: placeholderErrors,
              patch_count: patches.length,
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
