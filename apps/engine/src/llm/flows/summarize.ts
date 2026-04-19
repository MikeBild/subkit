// `summarize` flow — compact plain-text summary of arbitrary input.
// Thin wrapper around `core/invoke.ts`.

import type { Db } from "../../db/client.ts";
import { invoke, resolveModelRoute } from "../core/invoke.ts";
import { detectConfiguredProvider } from "../core/model-init.ts";
import type { EnhancedPrompt, ModelRoute } from "../types.ts";

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

function summarizeProviderEnvVar(): string {
  return process.env.SUMMARIZE_LLM_PROVIDER ? "SUMMARIZE_LLM_PROVIDER" : "LLM_PROVIDER";
}

function resolveSummarizeRoute(baseRoute: ModelRoute): ModelRoute {
  const detected = detectConfiguredProvider({
    providerEnvVar: summarizeProviderEnvVar(),
  });
  return {
    ...baseRoute,
    primary: process.env.SUMMARIZE_MODEL ?? baseRoute.primary,
    provider: detected === "unconfigured" ? baseRoute.provider : detected,
  };
}

export async function runSummarizeFlow(p: SummarizeParams, exec?: Db): Promise<SummarizeResult> {
  const route = resolveSummarizeRoute(await resolveModelRoute(p.tenant_id, exec));
  const r = await invoke(
    {
      flow: "summarize",
      tenant_id: p.tenant_id,
      user_turns: [{ role: "user", content: p.prompt }],
      route,
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
