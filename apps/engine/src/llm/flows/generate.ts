// `generate` flow — natural-language prompt → WorkflowDef draft.
//
// The flow is intentionally thin: Context Enhancement builds the prompt,
// the provider runs it with fallback, and we hand back the structured
// JSON for the REST layer to return alongside the grounding metadata.

import type { Db } from "../../db/client.ts";
import type { WorkflowDef } from "../../workflows/types.ts";
import { assembleEnhancedPrompt } from "../context.ts";
import { callWithFallback, resolveModelRoute } from "../provider.ts";
import type { EnhancedPrompt } from "../types.ts";

export interface GenerateParams {
  tenant_id: string;
  description: string;
  connector_id?: string | undefined;
  workflow_id?: string | undefined;
  preview?: boolean | undefined;
}

export interface GenerateResult {
  draft_workflow: Partial<WorkflowDef>;
  raw_text: string;
  included_skill_ids: string[];
  included_chunk_ids: string[];
  tokens: EnhancedPrompt["token_counts"];
  model_used: string;
  fell_back: boolean;
}

export async function runGenerateFlow(p: GenerateParams, exec?: Db): Promise<GenerateResult> {
  const route = await resolveModelRoute(p.tenant_id, exec);
  const prompt = await assembleEnhancedPrompt(
    {
      tenant_id: p.tenant_id,
      flow: "generate",
      ...(p.connector_id ? { connector_id: p.connector_id } : {}),
      ...(p.workflow_id ? { workflow_id: p.workflow_id } : {}),
      user_turns: [{ role: "user", content: p.description }],
      max_tokens: route.context_cap,
      model: route.primary,
    },
    exec,
  );
  const { result, model_used, fell_back } = await callWithFallback<Partial<WorkflowDef>>(
    { flow: "generate", route, prompt },
    exec,
  );
  let parsed: Partial<WorkflowDef> | undefined;
  if (!result.object && result.text) {
    try {
      parsed = JSON.parse(result.text) as Partial<WorkflowDef>;
    } catch {
      // Text was not pure JSON — object extraction already attempted by dispatch.
    }
  }
  return {
    draft_workflow: (result.object as Partial<WorkflowDef>) ?? parsed ?? {},
    raw_text: result.text,
    included_skill_ids: prompt.included_skill_ids,
    included_chunk_ids: prompt.included_chunk_ids,
    tokens: prompt.token_counts,
    model_used,
    fell_back,
  };
}
