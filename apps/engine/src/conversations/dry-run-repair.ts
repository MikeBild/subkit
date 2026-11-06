import type { Db } from "../db/client.ts";
import { deriveOutputBehavior } from "../workflows/output-behavior.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import { TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION } from "../workflows/types-web-scraper.ts";
import { MAX_PIPELINE_REPAIRS } from "./recorded-eval.ts";
import {
  repairTransformExpression,
  type TransformEvaluation,
  type TransformRepairLanguage,
} from "./transform-repair.ts";

interface DryRunRepairProposal {
  step_id: string | null;
  site: string;
  repair: Awaited<ReturnType<typeof repairTransformExpression>>;
}

export interface WorkflowOutputSite {
  site: "output_transform" | "output_transform_function";
  language: TransformRepairLanguage;
  expression: string;
}

export function workflowOutputSite(
  def: Pick<WorkflowDef, "output_transform" | "output_transform_function">,
): WorkflowOutputSite | null {
  const behavior = deriveOutputBehavior(def);
  if (behavior === "explicit_transform" && def.output_transform) {
    return { site: "output_transform", language: "jsonata", expression: def.output_transform };
  }
  if (behavior === "transform_function" && def.output_transform_function) {
    return {
      site: "output_transform_function",
      language: "javascript",
      expression: def.output_transform_function,
    };
  }
  return null;
}

interface StepLike {
  id: string;
  kind: string;
  language?: string | undefined;
  expression?: unknown;
  body?: unknown;
  then_steps?: unknown;
  else_steps?: unknown;
  branches?: unknown;
}

interface RunWarningLike {
  code: string;
  message: string;
  step_key?: string | null;
}

export async function proposeDryRunRepairs(opts: {
  steps: StepLike[];
  runWarnings: RunWarningLike[];
  runError: { code: string; message: string } | null | undefined;
  output: WorkflowOutputSite | null;
  outputEvaluation: TransformEvaluation | null;
  previewScope: Record<string, unknown>;
  input: unknown;
  tenant_id: string;
  db: Db;
  signal?: AbortSignal;
}): Promise<DryRunRepairProposal[]> {
  const {
    steps,
    runWarnings,
    runError,
    output,
    outputEvaluation,
    previewScope,
    input,
    tenant_id,
    db,
    signal,
  } = opts;
  const proposals: DryRunRepairProposal[] = [];
  let repairBudget = MAX_PIPELINE_REPAIRS;

  const controlFlowChildIds = new Set<string>();
  for (const s of steps) {
    const collect = (arr: unknown): void => {
      if (!Array.isArray(arr)) return;
      for (const child of arr) if (typeof child === "string") controlFlowChildIds.add(child);
    };
    collect(s.body);
    collect(s.then_steps);
    collect(s.else_steps);
    if (Array.isArray(s.branches)) for (const br of s.branches) collect(br);
  }

  const repairedStepIds = new Set<string>();
  for (const w of runWarnings) {
    if (w.code !== "transform_empty_extraction" && w.code !== "unresolved_identifier") {
      continue;
    }
    if (repairBudget <= 0) break;
    const stepId = w.step_key;
    if (!stepId || repairedStepIds.has(stepId) || controlFlowChildIds.has(stepId)) continue;
    const step = steps.find((s) => s.id === stepId);
    if (
      step?.kind !== "transform" ||
      typeof step.expression !== "string" ||
      TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION.has(step.language ?? "javascript")
    ) {
      continue;
    }
    repairedStepIds.add(stepId);
    repairBudget--;
    proposals.push({
      step_id: stepId,
      site: `steps.${stepId}.expression`,
      repair: await repairTransformExpression({
        expression: step.expression,
        language: "javascript",
        finding: {
          kind: w.code === "transform_empty_extraction" ? "empty_result" : "eval_error",
          message: w.message,
        },
        evaluation: { kind: "step_scope", scope: previewScope, input },
        site: `steps.${stepId}.expression`,
        tenant_id,
        db,
        ...(signal ? { signal } : {}),
      }),
    });
  }

  if (repairBudget > 0 && runError?.code === "output_transform_failed" && output) {
    proposals.push({
      step_id: null,
      site: output.site,
      repair: await repairTransformExpression({
        expression: output.expression,
        language: output.language,
        finding: { kind: "eval_error", message: runError.message },
        ...(outputEvaluation ? { evaluation: outputEvaluation } : {}),
        site: output.site,
        tenant_id,
        db,
        ...(signal ? { signal } : {}),
      }),
    });
  }

  return proposals;
}
