import { STDLIB_VERSION } from "../sandboxes/quickjs/stdlib/index.ts";
import type { DomainWorkflowDef } from "./domain-types.ts";

export function workflowUsesSandboxedJs(def: Pick<DomainWorkflowDef, "steps">): boolean {
  for (const step of def.steps) {
    if (step.kind === "transform" && step.language === "javascript") return true;
  }
  return false;
}

export function annotateRuntime<T extends DomainWorkflowDef>(def: T): T;
export function annotateRuntime(def: DomainWorkflowDef): DomainWorkflowDef {
  if (!workflowUsesSandboxedJs(def)) return def;
  return {
    ...def,
    runtime: {
      ...(def.runtime ?? {}),
      stdlib_version: STDLIB_VERSION,
    },
  };
}
