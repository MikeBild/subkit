import { rewriteLoopsToForEachDomain } from "./core/loop-rewrite.ts";
import type { WorkflowDef } from "./types.ts";
import { type ValidateOptions, validateWorkflowDef } from "./validator.ts";

export {
  type DomainLoopToForEachRewrite,
  type LoopToForEachChange,
  rewriteLoopsToForEachDomain,
} from "./core/loop-rewrite.ts";

import type { LoopToForEachChange } from "./core/loop-rewrite.ts";

export type WorkflowLoopToForEachRewrite =
  | { ok: true; changed: boolean; def: WorkflowDef; changes: LoopToForEachChange[] }
  | { ok: false; reason: string; loop_step_id?: string };

export function rewriteLoopsToForEach(
  def: WorkflowDef,
  options: ValidateOptions = {},
): WorkflowLoopToForEachRewrite {
  const rewritten = rewriteLoopsToForEachDomain(def);
  if (!rewritten.ok) return rewritten;
  if (!rewritten.changed) return { ...rewritten, def };

  const validation = validateWorkflowDef(rewritten.def, options);
  if (!validation.ok || !validation.workflow) {
    return {
      ok: false,
      reason: `rewritten definition failed validation: ${validation.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    };
  }

  return { ok: true, changed: true, def: validation.workflow, changes: rewritten.changes };
}
