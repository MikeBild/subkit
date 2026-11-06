import { recordAuthoringGateBlock } from "../../../observability/instrumentation.ts";
import { stepCycles } from "../../../workflows/core/definition.ts";
import { renderCycleReport } from "../../../workflows/dag.ts";
import { validateTenantWorkflowDef } from "../../../workflows/index.ts";
import {
  describeStepReferences,
  validateUnsupportedPlaceholders,
} from "../../../workflows/reference-validator.ts";
import type { StepDef, WorkflowDef } from "../../../workflows/types.ts";
import { withLatestPreview } from "../../authoring-state/index.ts";
import {
  describeUnsupportedPlaceholders,
  invalidDraftStepId,
  isRunnableStep,
} from "../../core/dry-run.ts";
import type { WorkflowDraftDocument } from "../../types.ts";
import { buildGateError, buildLifecyclePayload } from "../authoring-contract.ts";
import type { ToolContext, ToolResult } from "../index.ts";
import { classifyStepReferences } from "../inherited-step-references.ts";
import { placeholderDestinationGateResult } from "../placeholder-destination-gate.ts";
import type { DryRunArgs } from "./env.ts";

const TOOL = "dry_run_workflow";
const INVALID_SUMMARY = "Preview blocked until the workflow draft validates cleanly.";

export interface GatedDraft {
  steps: StepDef[];
  definition: WorkflowDef;
  inheritedReferencesField: Record<string, unknown>;
}

export type GateOutcome = { blocked: ToolResult } | { passed: GatedDraft };

function structuralGateError(
  ctx: ToolContext,
  error_code: string,
  message: string,
  extra: Record<string, unknown>,
): ToolResult {
  recordAuthoringGateBlock({ code: error_code, tool: TOOL });
  return {
    ok: false,
    data: buildGateError(ctx.getDraft(), {
      error_code,
      message,
      recommended_mode: "workflow",
      next_best_actions: ["inspect_workflow_draft", "edit_workflow_patch"],
      extra,
    }),
  };
}

async function invalidDraftResult(
  ctx: ToolContext,
  draft: WorkflowDraftDocument,
  errors: unknown,
): Promise<ToolResult> {
  const nextDraft = withLatestPreview(
    ctx.getDraft(),
    {
      ok: false,
      step_id: invalidDraftStepId(draft.steps),
      summary: INVALID_SUMMARY,
      preview: null,
    },
    TOOL,
    "workflow_previewed",
  );
  await ctx.setDraft(nextDraft);
  return {
    ok: false,
    data: buildLifecyclePayload(nextDraft, {
      name: draft.name,
      errors,
      steps: draft.steps.length,
      summary: INVALID_SUMMARY,
    }),
  };
}

function shapeGate(ctx: ToolContext, draftName: string, steps: StepDef[]): ToolResult | null {
  const cycleReport = stepCycles({ name: draftName, steps });
  if (cycleReport.has_cycle) {
    return structuralGateError(
      ctx,
      "workflow_cycle_detected",
      `workflow has a cyclic step dependency: ${renderCycleReport(cycleReport)}`,
      { cycles: cycleReport.cycles },
    );
  }
  const placeholderErrors = validateUnsupportedPlaceholders({ name: draftName, steps });
  if (placeholderErrors.length > 0) {
    return structuralGateError(
      ctx,
      "workflow_unsupported_placeholder",
      `workflow contains placeholder forms the runtime will not substitute: ${describeUnsupportedPlaceholders(placeholderErrors)}`,
      { unsupported_placeholders: placeholderErrors },
    );
  }
  return null;
}

export async function gateDraft(
  ctx: ToolContext,
  args: DryRunArgs,
  draft: WorkflowDraftDocument,
  sensitiveDraft: boolean,
): Promise<GateOutcome> {
  if (args.mode === "schema_only" && !sensitiveDraft) {
    return {
      blocked: {
        ok: false,
        error_code: "schema_only_requires_sensitive_draft",
        message:
          "mode schema_only is reserved for sensitive drafts; run dry_run_workflow without mode for the held preview.",
        next_best_actions: ["dry_run_workflow"],
      },
    };
  }
  const validation = await validateTenantWorkflowDef(draft, ctx.tenant_id, ctx.db, {
    destinationTier: "all",
  });
  const placeholderDestinations = validation.placeholder_destinations ?? [];
  if (placeholderDestinations.length > 0) {
    return {
      blocked: placeholderDestinationGateResult(ctx.getDraft(), placeholderDestinations, TOOL),
    };
  }
  if (!validation.ok) {
    return { blocked: await invalidDraftResult(ctx, draft, validation.errors) };
  }
  const steps = draft.steps.filter(isRunnableStep);
  if (steps.length === 0) {
    return {
      blocked: {
        ok: false,
        data: {
          error: "workflow draft has no runnable steps",
          reason: "empty_draft",
        },
      },
    };
  }
  const draftName = draft.name ?? "draft";
  const shapeBlock = shapeGate(ctx, draftName, steps);
  if (shapeBlock) return { blocked: shapeBlock };

  const references = await classifyStepReferences(ctx, TOOL, {
    name: draftName,
    ...(draft.slug ? { slug: draft.slug } : {}),
    steps,
  } as WorkflowDef);
  const inheritedReferencesField = references.notice
    ? { inherited_step_references: references.notice }
    : {};
  if (references.introduced.length > 0) {
    return {
      blocked: structuralGateError(
        ctx,
        "workflow_unresolved_step_reference",
        `workflow has unresolved step references: ${describeStepReferences(references.introduced)}`,
        { unresolved_references: references.introduced, ...inheritedReferencesField },
      ),
    };
  }
  return {
    passed: {
      steps,
      definition: { ...validation.workflow, name: draftName, steps },
      inheritedReferencesField,
    },
  };
}
