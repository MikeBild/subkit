import { z } from "@hono/zod-openapi";
import type { Db } from "../../db/client.ts";
import { invoke } from "../runtime/invoke.ts";
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
      "gate_fix",
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
type ModelPatchProposal = z.infer<typeof PatchProposalRuntimeSchema>;

export interface PreviousRepairAttempt {
  proposal: PatchProposal;
  rejection: string;
}

interface RepairParams {
  tenant_id: string;
  execution_id: string | null;
  scan_id?: string | undefined;
  failing_step: {
    id: string;
    request?: unknown;
    response?: unknown;
  };
  drift_diff: string;
  connector_id?: string | undefined;
  previous_attempts?: PreviousRepairAttempt[];
}

interface RepairResult {
  patch_proposal: ModelPatchProposal;
  raw_text: string;
  included_skill_ids: string[];
  included_chunk_ids: string[];
  tokens: EnhancedPrompt["token_counts"];
  model_used: string;
  fell_back: boolean;
}

export function repairOrigin(p: Pick<RepairParams, "execution_id" | "scan_id">): string {
  if (p.execution_id) return `Execution: ${p.execution_id}`;
  if (p.scan_id) return `Proactive scan: ${p.scan_id} (no execution)`;
  return "Proactive repair (no execution)";
}

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

  const r = await invoke<ModelPatchProposal>(
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
