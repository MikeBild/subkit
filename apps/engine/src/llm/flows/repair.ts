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
  execution_id: string;
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
    `Execution: ${p.execution_id}`,
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
      telemetry_metadata: {
        execution_id: p.execution_id,
        failing_step: p.failing_step.id,
        attempt: previous.length + 1,
      },
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
