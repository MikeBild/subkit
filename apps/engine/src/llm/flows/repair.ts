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

export const PatchProposalSchema = z
  .object({
    classification: z.enum(["safe", "unsafe"]),
    kind: z.enum(["update_field_path", "rename_param", "change_type", "add_header", "other"]),
    description: z.string(),
    patch: z.record(z.string(), z.unknown()),
    reasoning: z.string(),
  })
  .openapi("PatchProposal");

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

function coerceProposal(obj: unknown, fallbackReason: string): PatchProposal {
  // The mock provider returns `{patch, classification, notes}`. We
  // normalise whatever shape we get into the documented PatchProposal
  // envelope — missing fields fall back to conservative defaults.
  const src = (obj ?? {}) as Record<string, unknown>;
  const classification =
    src.classification === "safe" || src.classification === "unsafe"
      ? (src.classification as "safe" | "unsafe")
      : "safe";
  const kind =
    src.kind === "update_field_path" ||
    src.kind === "rename_param" ||
    src.kind === "change_type" ||
    src.kind === "add_header" ||
    src.kind === "other"
      ? (src.kind as PatchProposal["kind"])
      : "update_field_path";
  const description =
    typeof src.description === "string" && src.description.length > 0
      ? src.description
      : typeof src.notes === "string"
        ? src.notes
        : "field path updated to match drifted response";
  const patch =
    (src.patch && typeof src.patch === "object" ? (src.patch as Record<string, unknown>) : {}) ??
    {};
  const reasoning =
    typeof src.reasoning === "string" && src.reasoning.length > 0 ? src.reasoning : fallbackReason;
  return { classification, kind, description, patch, reasoning };
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
  const { result, model_used, fell_back } = await callWithFallback<unknown>(
    { flow: "repair", route, prompt },
    exec,
  );
  let parsed: unknown;
  if (!result.object && result.text) {
    try {
      parsed = JSON.parse(result.text);
    } catch {
      // Text was not pure JSON — object extraction already attempted by dispatch.
    }
  }
  const raw = result.object ?? parsed ?? {};
  const proposal = coerceProposal(raw, `Drift diff observed in step ${p.failing_step.id}`);
  return {
    patch_proposal: proposal,
    raw_text: result.text,
    included_skill_ids: prompt.included_skill_ids,
    included_chunk_ids: prompt.included_chunk_ids,
    tokens: prompt.token_counts,
    model_used,
    fell_back,
  };
}
