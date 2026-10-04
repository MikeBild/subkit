import type { LoopStep, StepDef, WorkflowDef } from "./types.ts";
import { validateWorkflowDef } from "./validator.ts";

export interface LoopToForEachChange {
  loop_step_id: string;
  body_step_id: string;
  for_each: string;
  original_selector: string;
  selector_source: "data_selector" | "over";
}

export type WorkflowLoopToForEachRewrite =
  | { ok: true; changed: boolean; def: WorkflowDef; changes: LoopToForEachChange[] }
  | { ok: false; reason: string; loop_step_id?: string };

const PLAIN_DOT_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d+\])*$/;

function overToForEach(over: string): string | null {
  const trimmed = over.trim();
  if (!PLAIN_DOT_PATH_RE.test(trimmed)) return null;
  return `(sourceData) => sourceData.${trimmed}`;
}

function stepReferencesLoopId(step: StepDef, loopStepId: string): boolean {
  const hay = JSON.stringify(step);
  return hay.includes(loopStepId);
}

export function rewriteLoopsToForEach(def: WorkflowDef): WorkflowLoopToForEachRewrite {
  const loops = def.steps.filter((s): s is LoopStep => s.kind === "loop");
  if (loops.length === 0) {
    return { ok: true, changed: false, def, changes: [] };
  }

  const changes: LoopToForEachChange[] = [];
  const outSteps: StepDef[] = def.steps.map((s) => ({ ...s }) as StepDef);
  const loopStepIdsToRemove = new Set<string>();

  for (const loop of loops) {
    if (loop.body.length !== 1) continue;
    const bodyStepId = loop.body[0];
    if (!bodyStepId) continue;

    let forEachExpr: string | null = null;
    let selectorSource: "data_selector" | "over";
    if (loop.data_selector !== undefined) {
      forEachExpr = loop.data_selector;
      selectorSource = "data_selector";
    } else if (loop.over !== undefined) {
      forEachExpr = overToForEach(loop.over);
      if (forEachExpr === null) continue;
      selectorSource = "over";
    } else {
      continue;
    }

    const bodyIdSet = new Set(loop.body);
    const hasStepRef = def.steps.some(
      (s) => s.id !== loop.id && !bodyIdSet.has(s.id) && stepReferencesLoopId(s, loop.id),
    );
    const rootFieldsHay = [
      def.output_transform,
      def.output_transform_function,
      def.validation_function,
      def.output_schema !== undefined ? JSON.stringify(def.output_schema) : undefined,
    ]
      .filter((v): v is string => typeof v === "string")
      .join("\0");
    const hasRootRef = rootFieldsHay.includes(loop.id);
    if (hasStepRef || hasRootRef) continue;

    const bodyStepIndex = outSteps.findIndex((s) => s.id === bodyStepId);
    if (bodyStepIndex === -1) {
      return {
        ok: false,
        reason: `loop body step "${bodyStepId}" not found in workflow steps`,
        loop_step_id: loop.id,
      };
    }
    const bodyStep = outSteps[bodyStepIndex];
    if (!bodyStep) continue;
    if ((bodyStep as { for_each?: string }).for_each !== undefined) continue;

    outSteps[bodyStepIndex] = { ...bodyStep, for_each: forEachExpr } as StepDef;
    loopStepIdsToRemove.add(loop.id);
    changes.push({
      loop_step_id: loop.id,
      body_step_id: bodyStepId,
      for_each: forEachExpr,
      original_selector: loop.data_selector ?? loop.over ?? "",
      selector_source: selectorSource!,
    });
  }

  if (changes.length === 0) {
    return { ok: true, changed: false, def, changes: [] };
  }

  const filteredSteps = outSteps.filter((s) => !loopStepIdsToRemove.has(s.id));

  const newDef: WorkflowDef = { ...def, steps: filteredSteps };

  const validation = validateWorkflowDef(newDef);
  if (!validation.ok || !validation.workflow) {
    return {
      ok: false,
      reason: `rewritten definition failed validation: ${validation.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    };
  }

  return { ok: true, changed: true, def: validation.workflow, changes };
}
