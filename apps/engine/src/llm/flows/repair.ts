// `repair` flow — propose the smallest safe patch that makes a failing
// step compatible with a drifted response shape.
//
// Inputs come from the self-healing pipeline: an execution id, the
// failing step descriptor, and a textual diff between the previously
// captured schema and the new response. We run the full context
// enhancement pipeline so the LLM has the connector's skills + ingested
// docs in scope, then the provider emits a `PatchProposal` matching the
// canned shape documented in docs/16-ai-flows.md. The caller (the
// self-healing loop in P7) decides whether to auto-apply, stage, or
// reject the proposal based on `classification`.

import { z } from "@hono/zod-openapi";
import type { Db } from "../../db/client.ts";
import { assembleEnhancedPrompt } from "../context.ts";
import { callWithFallback, resolveModelRoute } from "../provider.ts";
import type { EnhancedPrompt, PriorFailure } from "../types.ts";

// PatchProposalSchema is used both as the OpenAPI spec surface (via
// `.openapi()`) and — via the SDK-native schema below — as the runtime
// validator for `generateObject`. We keep them split because Zod v4's
// `.openapi()` tag trips the SDK's inferred type machinery when the
// schema is handed directly to `generateObject`.
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
  const route = await resolveModelRoute(p.tenant_id, exec);
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
  const prompt = await assembleEnhancedPrompt(
    {
      tenant_id: p.tenant_id,
      flow: "repair",
      ...(p.connector_id ? { connector_id: p.connector_id } : {}),
      user_turns: [{ role: "user", content: userContent }],
      prior_failures: [priorFailure],
      max_tokens: route.context_cap,
      model: route.primary,
    },
    exec,
  );
  // `generateObject` with the runtime schema enforces validation at the
  // SDK layer — the old rope-extraction + coerceProposal safety net is
  // gone. On shape failures an `AI_NoObjectGeneratedError` propagates
  // and the HTTP layer surfaces a 502.
  const { result, model_used, fell_back } = await callWithFallback<PatchProposal>(
    {
      flow: "repair",
      route,
      prompt,
      schema: PatchProposalRuntimeSchema,
      telemetry_metadata: { execution_id: p.execution_id, failing_step: p.failing_step.id },
    },
    exec,
  );
  if (!result.object) {
    // Only reachable when the mock provider returns an undefined object
    // — real calls validate against the schema and throw instead.
    throw new Error("repair flow: provider returned empty object");
  }
  return {
    patch_proposal: result.object,
    raw_text: result.text,
    included_skill_ids: prompt.included_skill_ids,
    included_chunk_ids: prompt.included_chunk_ids,
    tokens: prompt.token_counts,
    model_used,
    fell_back,
  };
}
