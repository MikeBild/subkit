// Decision helper for `sk executions rerun <id>`. Shared between the
// command runner (`commands/executions.ts`) and the unit-test fixture
// (`commands/executions-rerun.test.ts`) so a future change to the
// `source_kind` allowlist or body shape can't drift between
// implementation and test.

import type { RunExecutionBody } from "../engine-client.ts";

export interface PriorExecution {
  workflow_id?: unknown;
  source_kind?: unknown;
  source_ref?: unknown;
}

/**
 * The shape that `EngineClient.runExecution` accepts for the saved-source
 * branch. Re-using the engine-client type means a future drift to the
 * `POST /v1/executions` payload propagates here at compile time.
 */
export type RerunBody = Extract<RunExecutionBody, { source: "saved" }> & {
  request_source: "cli";
};

export interface RerunResult {
  ok: true;
  body: RerunBody;
}

export interface RerunRefusal {
  ok: false;
  reason: string;
}

export type RerunDecision = RerunResult | RerunRefusal;

/**
 * Resolve a saved execution into a fresh `runExecution` body. Refuses
 * when the prior execution is not bound to a saved workflow (i.e.
 * source_kind ≠ "saved" or workflow_id missing) — that's the contract
 * the engine endpoint enforces too.
 */
export function buildRerunDecision(prior: PriorExecution): RerunDecision {
  const workflow_id = typeof prior.workflow_id === "string" ? prior.workflow_id : undefined;
  if (!workflow_id) {
    return {
      ok: false,
      reason: `execution is not bound to a saved workflow (source_kind=${prior.source_kind ?? "unknown"}); rerun requires a saved workflow.`,
    };
  }
  const sourceRef = (prior.source_ref ?? null) as Record<string, unknown> | null;
  const priorInput = sourceRef?.input;
  const body: RerunBody = {
    source: "saved",
    workflow_id,
    ...(priorInput !== undefined ? { input: priorInput } : {}),
    request_source: "cli",
  };
  return { ok: true, body };
}
