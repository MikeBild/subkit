import { STDLIB_VERSION } from "../sandboxes/quickjs/stdlib/index.ts";
import type { WorkflowDef } from "./types.ts";

export function workflowUsesSandboxedJs(def: WorkflowDef): boolean {
  for (const step of def.steps) {
    if (step.kind === "transform" && step.language === "javascript") return true;
  }
  return false;
}

export function annotateRuntime(def: WorkflowDef): WorkflowDef {
  if (!workflowUsesSandboxedJs(def)) return def;
  return {
    ...def,
    runtime: {
      ...(def.runtime ?? {}),
      stdlib_version: STDLIB_VERSION,
    },
  };
}
