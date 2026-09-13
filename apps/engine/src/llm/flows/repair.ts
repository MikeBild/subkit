// `repair` flow — propose the smallest safe patch that makes a failing
// step compatible with a drifted response shape.

import { z } from "@hono/zod-openapi";

import type { Db } from "../../db/client.ts";
import { invoke } from "../core/invoke.ts";
import type { EnhancedPrompt, PriorFailure } from "../types.ts";

export const PatchProposalSchema = z
  .object({
    classification: z.enum(["safe", "unsafe"]),
    kind: z.enum([
      "update_field_path",
      "rename_param",
      "change_type",
      "add_header",
      "rate_limited",
      "other",
    ]),
    description: z.string(),
    patch: z.record(z.string(), z.unknown()),
    reasoning: z.string(),
  })
  .openapi("PatchProposal");

const PatchProposalRuntimeSchema = z.object({
  classification: z.enum(["safe", "unsafe"]),
  kind: z.enum([
    "update_field_path",
    "rename_param",
    "change_type",
    "add_header",
    "rate_limited",
    "other",
  ]),
  description: z.string(),
  patch: z.record(z.string(), z.unknown()),
  reasoning: z.string(),
});

export type PatchProposal = z.infer<typeof PatchProposalSchema>;

export interface PreviousRepairAttempt {
  proposal: PatchProposal;
  rejection: string;
}

export interface RepairParams {
  tenant_id: string;
  /**
   * The execution being repaired, or null when there is none.
   *
   * Nullable on purpose. While this was a required `string`, the proactive
   * caller had no execution to name and filled it with whatever was at hand —
   * a `self_healing_scans.id`, or the literal "proactive". A scan id is a
   * well-formed uuid, so 163 rows were written into `llm_usage.execution_id`
   * that look like an execution reference and resolve to nothing; "proactive"
   * is not a uuid at all, so that insert throws and is swallowed by the
   * best-effort accounting catch, losing the row outright.
   *
   * A required field that a caller cannot honestly fill does not get filled
   * honestly. Null is the answer to "which execution?" when there is none.
   */
  execution_id: string | null;
  /** The proactive scan that triggered this repair, when it was not an execution. */
  scan_id?: string | undefined;
  failing_step: {
    id: string;
    request?: unknown;
    response?: unknown;
  };
  drift_diff: string;
  connector_id?: string | undefined;
  /**
   * Previous repair proposals that were rejected by the classifier or the
   * fixture dry-run. Each entry is folded into `prior_failures` so the model
   * can revise instead of re-emitting the same shape. Populated by
   * `runSelfHealingLoop` across retry attempts.
   */
  previous_attempts?: PreviousRepairAttempt[];
}

export interface RepairResult {
  patch_proposal: PatchProposal;
  raw_text: string;
  included_skill_ids: string[];
  included_chunk_ids: string[];
  tokens: EnhancedPrompt["token_counts"];
  model_used: string;
  fell_back: boolean;
}

/**
 * The line that tells the model what it is looking at.
 *
 * It used to be `Execution: ${p.execution_id}` unconditionally, which read
 * "Execution: <a self_healing_scans uuid>" or "Execution: proactive" whenever
 * there was no execution — a false statement about the origin, made to the
 * one reader who cannot check it.
 *
 * Exported so it can be tested without a provider: this and `repairTelemetry`
 * are the whole of what the nullable `execution_id` changed, and neither
 * should need a live LLM call to pin down.
 */
export function repairOrigin(p: Pick<RepairParams, "execution_id" | "scan_id">): string {
  if (p.execution_id) return `Execution: ${p.execution_id}`;
  if (p.scan_id) return `Proactive scan: ${p.scan_id} (no execution)`;
  return "Proactive repair (no execution)";
}

/**
 * Telemetry for the repair call.
 *
 * `execution_id` appears only when there is one. The accountant copies that
 * key straight into `llm_usage.execution_id`, so putting anything else there
 * is a claim about a row in `executions` — and the column had no foreign key
 * to test the claim until migration 0040. The scan gets its own key rather
 * than borrowing that one.
 */
export function repairTelemetry(
  p: Pick<RepairParams, "execution_id" | "scan_id" | "failing_step">,
  attempt: number,
): Record<string, string | number | boolean> {
  return {
    ...(p.execution_id ? { execution_id: p.execution_id } : {}),
    ...(p.scan_id ? { scan_id: p.scan_id } : {}),
    failing_step: p.failing_step.id,
    attempt,
  };
}

export async function runRepairFlow(p: RepairParams, exec?: Db): Promise<RepairResult> {
  const priorFailures: PriorFailure[] = [
    {
      step_id: p.failing_step.id,
      error: `step ${p.failing_step.id} failed with drift in execution ${p.execution_id}`,
      schema_diff: p.drift_diff,
      ...(p.failing_step.response !== undefined
        ? { captured_response: JSON.stringify(p.failing_step.response).slice(0, 4_000) }
        : {}),
    },
  ];

  // Fold previous rejected attempts into prior_failures so the model sees why
  // last-turn's proposal was not good enough and produces a different shape.
  const previous = p.previous_attempts ?? [];
  for (const [idx, attempt] of previous.entries()) {
    priorFailures.push({
      step_id: `${p.failing_step.id}#attempt_${idx + 1}`,
      error: `previous patch proposal rejected: ${attempt.rejection}`,
      schema_diff: JSON.stringify(attempt.proposal).slice(0, 4_000),
    });
  }

  const attemptHint =
    previous.length > 0
      ? `\n\nThis is retry attempt ${previous.length + 1}. Previous proposals were rejected — consult prior_failures and propose a different patch shape, not a near-duplicate.`
      : "";

  const userContent = [
    repairOrigin(p),
    `Failing step: ${p.failing_step.id}`,
    "",
    "Drift diff:",
    p.drift_diff,
    "",
    `Propose a minimal patch that restores compatibility.${attemptHint}`,
  ].join("\n");

  const r = await invoke<PatchProposal>(
    {
      flow: "repair",
      tenant_id: p.tenant_id,
      user_turns: [{ role: "user", content: userContent }],
      prior_failures: priorFailures,
      ...(p.connector_id ? { connector_id: p.connector_id } : {}),
      schema: PatchProposalRuntimeSchema,
      telemetry_metadata: repairTelemetry(p, previous.length + 1),
    },
    exec,
  );
  if (!r.object) {
    throw new Error("repair flow: provider returned empty object");
  }
  return {
    patch_proposal: r.object,
    raw_text: r.text,
    included_skill_ids: r.assembled.prompt.included_skill_ids,
    included_chunk_ids: r.assembled.prompt.included_chunk_ids,
    tokens: r.assembled.prompt.token_counts,
    model_used: r.model_used,
    fell_back: r.fell_back,
  };
}
