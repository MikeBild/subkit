import type { DomainLoopStep, DomainStepDef, DomainWorkflowDef } from "../domain-types.ts";

export interface LoopToForEachChange {
  loop_step_id: string;
  body_step_id: string;
  for_each: string;
  original_selector: string;
  selector_source: "data_selector" | "over";
}

export type DomainLoopToForEachRewrite =
  | { ok: true; changed: boolean; def: DomainWorkflowDef; changes: LoopToForEachChange[] }
  | { ok: false; reason: string; loop_step_id?: string };

const PLAIN_DOT_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d+\])*$/;

function overToForEach(over: string): string | null {
  const trimmed = over.trim();
  if (!PLAIN_DOT_PATH_RE.test(trimmed)) return null;
  return `(sourceData) => sourceData.${trimmed}`;
}

function stepReferencesLoopId(step: DomainStepDef, loopStepId: string): boolean {
  return JSON.stringify(step).includes(loopStepId);
}

export function rewriteLoopsToForEachDomain(def: DomainWorkflowDef): DomainLoopToForEachRewrite {
  const loops = def.steps.filter((step): step is DomainLoopStep => step.kind === "loop");

  const changes: LoopToForEachChange[] = [];
  const outSteps: DomainStepDef[] = def.steps.map((step) => ({ ...step }));
  const loopStepIdsToRemove = new Set<string>();

  for (const loop of loops) {
    if (loop.body.length !== 1) continue;
    const bodyStepId = loop.body[0];
    if (!bodyStepId) continue;

    let forEachExpr: string | null = null;
    let selectorSource: "data_selector" | "over";
    let originalSelector: string;
    if (loop.data_selector !== undefined) {
      forEachExpr = loop.data_selector;
      selectorSource = "data_selector";
      originalSelector = loop.data_selector;
    } else if (loop.over !== undefined) {
      forEachExpr = overToForEach(loop.over);
      if (forEachExpr === null) continue;
      selectorSource = "over";
      originalSelector = loop.over;
    } else {
      continue;
    }

    const bodyIdSet = new Set(loop.body);
    const hasStepRef = def.steps.some(
      (step) =>
        step.id !== loop.id && !bodyIdSet.has(step.id) && stepReferencesLoopId(step, loop.id),
    );
    const rootFieldsHay = [
      def.output_transform,
      def.output_transform_function,
      def.validation_function,
      JSON.stringify(def.output_schema),
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\0");
    if (hasStepRef || rootFieldsHay.includes(loop.id)) continue;

    const bodyStepIndex = outSteps.findIndex((step) => step.id === bodyStepId);
    if (bodyStepIndex === -1) {
      return {
        ok: false,
        reason: `loop body step "${bodyStepId}" not found in workflow steps`,
        loop_step_id: loop.id,
      };
    }
    const bodyStep = outSteps[bodyStepIndex]!;
    if (bodyStep.for_each !== undefined) continue;

    outSteps[bodyStepIndex] = { ...bodyStep, for_each: forEachExpr };
    loopStepIdsToRemove.add(loop.id);
    changes.push({
      loop_step_id: loop.id,
      body_step_id: bodyStepId,
      for_each: forEachExpr,
      original_selector: originalSelector,
      selector_source: selectorSource,
    });
  }

  if (changes.length === 0) return { ok: true, changed: false, def, changes: [] };
  return {
    ok: true,
    changed: true,
    def: { ...def, steps: outSteps.filter((step) => !loopStepIdsToRemove.has(step.id)) },
    changes,
  };
}
