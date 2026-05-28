// Decision helper for `sk executions rerun <id>`. Shared between the
// command runner (`commands/executions.ts`) and the unit-test fixture
// (`commands/executions-rerun.test.ts`) so a future change to the
// `source_kind` allowlist or body shape can't drift between
// implementation and test.

import { z } from "zod";
import type { RunExecutionBody } from "../engine-client.ts";

/**
 * Zod-validated shape of a prior `executions` row as returned by the
 * engine's `GET /v1/executions/:id`. Anything beyond these three fields
 * is passthrough — the rerun helper only depends on `workflow_id`,
 * `source_kind`, and `source_ref.input`. Treating the network payload
 * as untrusted input here matches the AGENTS.md "Zod at boundaries"
 * rule for CLI surfaces.
 */
const PriorExecutionSchema = z
  .object({
    workflow_id: z.string().optional(),
    source_kind: z.string().optional(),
    source_ref: z.object({ input: z.unknown().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();

export type PriorExecution = z.infer<typeof PriorExecutionSchema>;

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
 * the engine endpoint enforces too. The input is Zod-validated so a
 * corrupted or malicious row produces a deterministic refusal rather
 * than a confusing downstream error.
 */
export function buildRerunDecision(prior: unknown): RerunDecision {
  const parsed = PriorExecutionSchema.safeParse(prior);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `prior execution payload did not match the expected shape (${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}); rerun requires a saved-source execution.`,
    };
  }
  const workflow_id = parsed.data.workflow_id;
  if (!workflow_id) {
    return {
      ok: false,
      reason: `execution is not bound to a saved workflow (source_kind=${parsed.data.source_kind ?? "unknown"}); rerun requires a saved workflow.`,
    };
  }
  const priorInput = parsed.data.source_ref?.input;
  const body: RerunBody = {
    source: "saved",
    workflow_id,
    ...(priorInput !== undefined ? { input: priorInput } : {}),
    request_source: "cli",
  };
  return { ok: true, body };
}
