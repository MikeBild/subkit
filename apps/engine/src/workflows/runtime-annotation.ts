// Stamp the active sk-stdlib version onto a WorkflowDef when it
// contains JavaScript code that will run in the QuickJS sandbox. The
// annotation lives in `def.runtime.stdlib_version` and is persisted
// with the DAG. The self-healing drift detector reads it back to
// decide whether a major-bump migration is needed.

import { STDLIB_VERSION } from "../sandboxes/quickjs/stdlib/index.ts";
import type { WorkflowDef } from "./types.ts";

/**
 * Returns true when at least one step would execute user-supplied
 * JavaScript inside the QuickJS sandbox. Currently that's any
 * `transform` step with `language: "javascript"`. Hooks are not part
 * of the DAG and are tracked separately on `request_hooks`.
 */
export function workflowUsesSandboxedJs(def: WorkflowDef): boolean {
  for (const step of def.steps) {
    if (step.kind === "transform" && step.language === "javascript") return true;
  }
  return false;
}

/**
 * If the workflow uses sandboxed JS, stamp the current stdlib version
 * into `def.runtime`. Pure — returns a new object rather than
 * mutating the input. If no JS is detected, the workflow is returned
 * unchanged so we never write a runtime hint for workflows that don't
 * need one.
 */
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
