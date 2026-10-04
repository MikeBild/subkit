import type { Db } from "../db/client.ts";
import { TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION } from "../workflows/types-web-scraper.ts";
import { MAX_PIPELINE_REPAIRS } from "./recorded-eval.ts";
import { repairTransformExpression } from "./transform-repair.ts";

export interface DryRunRepairProposal {
  step_id: string | null;
  site: string;
  repair: Awaited<ReturnType<typeof repairTransformExpression>>;
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
  output_transform: unknown;
  previewScope: Record<string, unknown>;
  input: unknown;
  tenant_id: string;
  db: Db;
  signal?: AbortSignal;
}): Promise<DryRunRepairProposal[]> {
  const { steps, runWarnings, runError, previewScope, input, tenant_id, db, signal } = opts;
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
        scopeSample: previewScope,
        input,
        site: `steps.${stepId}.expression`,
        tenant_id,
        db,
        ...(signal ? { signal } : {}),
      }),
    });
  }

  if (
    repairBudget > 0 &&
    runError?.code === "output_transform_failed" &&
    typeof opts.output_transform === "string" &&
    opts.output_transform.length > 0
  ) {
    proposals.push({
      step_id: null,
      site: "output_transform",
      repair: await repairTransformExpression({
        expression: opts.output_transform,
        finding: { kind: "eval_error", message: runError.message },
        scopeSample: previewScope,
        input,
        site: "output_transform",
        tenant_id,
        db,
        ...(signal ? { signal } : {}),
      }),
    });
  }

  return proposals;
}
