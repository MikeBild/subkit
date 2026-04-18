// `repair` flow — propose the smallest safe patch that makes a failing
// step compatible with a drifted response shape.

import { z } from "@hono/zod-openapi";
import type { Db } from "../../db/client.ts";
import { invoke } from "../core/invoke.ts";
import type { EnhancedPrompt, PriorFailure } from "../types.ts";

export const PatchProposalSchema = z
  .object({
    classification: z.enum(["safe", "unsafe"]),
    kind: z.enum(["update_field_path", "rename_param", "change_type", "add_header", "other"]),
    description: z.string(),
    patch: z.record(z.string(), z.unknown()),
    reasoning: z.string(),
  })
  .openapi("PatchProposal");

const PatchProposalRuntimeSchema = z.object({
  classification: z.enum(["safe", "unsafe"]),
  kind: z.enum(["update_field_path", "rename_param", "change_type", "add_header", "other"]),
  description: z.string(),
  patch: z.record(z.string(), z.unknown()),
  reasoning: z.string(),
});

export type PatchProposal = z.infer<typeof PatchProposalSchema>;

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
  const priorFailure: PriorFailure = {
    step_id: p.failing_step.id,
    error: `step ${p.failing_step.id} failed with drift in execution ${p.execution_id}`,
    schema_diff: p.drift_diff,
    ...(p.failing_step.response !== undefined
      ? { captured_response: JSON.stringify(p.failing_step.response).slice(0, 4_000) }
      : {}),
  };
  const userContent = [
    `Execution: ${p.execution_id}`,
    `Failing step: ${p.failing_step.id}`,
    "",
    "Drift diff:",
    p.drift_diff,
    "",
    "Propose a minimal patch that restores compatibility.",
  ].join("\n");

  const r = await invoke<PatchProposal>(
    {
      flow: "repair",
      tenant_id: p.tenant_id,
      user_turns: [{ role: "user", content: userContent }],
      prior_failures: [priorFailure],
      ...(p.connector_id ? { connector_id: p.connector_id } : {}),
      schema: PatchProposalRuntimeSchema,
      telemetry_metadata: { execution_id: p.execution_id, failing_step: p.failing_step.id },
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
