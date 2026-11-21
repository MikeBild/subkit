import { logger } from "../../logging/index.ts";
import { buildStepDag, topoSort } from "../../workflows/dag.ts";
import { containerChildStepIds } from "../core/run.ts";
import type { RunEnv, RunPlan } from "./env.ts";

export function planRun(env: RunEnv): RunPlan {
  const { def } = env;
  const dag = buildStepDag(def);
  const stepIndexById = new Map(def.steps.map((s, i) => [s.id, i] as const));
  let executionOrder: ReadonlyArray<string>;
  try {
    executionOrder = topoSort(dag);
  } catch (err) {
    logger.error({
      module: "execution",
      action: "engine.topo_sort_fallback",
      msg: "topoSort failed at run time despite pre-flight cycle gate — falling back to declaration order",
      tenant_id: env.tenant_id,
      execution_id: env.execution_id,
      workflow_name: def.name,
      step_count: def.steps.length,
      error: err instanceof Error ? err.message : String(err),
    });
    executionOrder = def.steps.map((s) => s.id);
  }
  return {
    dag,
    executionOrder,
    stepIndexById,
    containerChildIds: containerChildStepIds(def.steps),
  };
}
