import {
  compile,
  describeUnknownFunction,
  findUnboundFunctionCalls,
  findUnknownFunctionCalls,
} from "../execution/jsonata-engine.ts";
import type { WorkflowDef } from "./types.ts";
import type { ValidationError } from "./validator.ts";

export interface JsonataSite {
  path: string;
  expression: string;
}

function isLoopSelector(over: string): boolean {
  return over === "$" || over.startsWith("$.");
}

export function workflowJsonataSites(def: WorkflowDef): JsonataSite[] {
  const sites: JsonataSite[] = [];
  for (const step of def.steps) {
    if (step.kind === "branch") {
      sites.push({ path: `steps.${step.id}.when`, expression: step.when });
    }
    if (
      step.kind === "loop" &&
      typeof step.over === "string" &&
      step.over.length > 0 &&
      !isLoopSelector(step.over)
    ) {
      sites.push({ path: `steps.${step.id}.over`, expression: step.over });
    }
  }
  if (typeof def.output_transform === "string" && def.output_transform.length > 0) {
    sites.push({ path: "output_transform", expression: def.output_transform });
  }
  if (typeof def.validation_expression === "string" && def.validation_expression.length > 0) {
    sites.push({ path: "validation_expression", expression: def.validation_expression });
  }
  return sites;
}

export function jsonataSiteErrors(def: WorkflowDef): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const { path, expression } of workflowJsonataSites(def)) {
    try {
      compile(expression);
    } catch (e) {
      errors.push({ path, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    for (const finding of findUnboundFunctionCalls(expression)) {
      errors.push({
        path,
        message: `JSONata function \`${finding.name}(...)\` is not bound; use \`${finding.suggestion}(...)\``,
      });
    }
    for (const finding of findUnknownFunctionCalls(expression)) {
      errors.push({ path, message: describeUnknownFunction(finding) });
    }
  }
  return errors;
}
