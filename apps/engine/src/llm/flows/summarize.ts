// `summarize` flow — compact plain-text summary of arbitrary input.
// Thin wrapper around `core/invoke.ts`.
//
// Per-flow env overrides (SUMMARIZE_LLM_PROVIDER / SUMMARIZE_MODEL) are
// applied centrally in `invoke.ts#applyFlowEnvOverrides`. Any flow name
// picks up `{FLOW}_LLM_PROVIDER` + `{FLOW}_MODEL` the same way.

import type { Db } from "../../db/client.ts";
import { invoke } from "../core/invoke.ts";
import type { EnhancedPrompt } from "../types.ts";

export interface SummarizeParams {
  tenant_id: string;
  prompt: string;
}

export interface SummarizeResult {
  summary: string;
  raw_text: string;
  tokens: EnhancedPrompt["token_counts"];
  model_used: string;
  fell_back: boolean;
}

export async function runSummarizeFlow(p: SummarizeParams, exec?: Db): Promise<SummarizeResult> {
  const r = await invoke(
    {
      flow: "summarize",
      tenant_id: p.tenant_id,
      user_turns: [{ role: "user", content: p.prompt }],
    },
    exec,
  );
  const summary = r.text.trim();
  return {
    summary,
    raw_text: r.text,
    tokens: r.assembled.prompt.token_counts,
    model_used: r.model_used,
    fell_back: r.fell_back,
  };
}
