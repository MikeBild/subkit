// `extract` flow — unstructured sample → canonical schema + data.

import type { Db } from "../../db/client.ts";
import { assembleEnhancedPrompt } from "../context.ts";
import { callWithFallback, resolveModelRoute } from "../provider.ts";
import type { EnhancedPrompt } from "../types.ts";

export interface ExtractParams {
  tenant_id: string;
  sample: string;
  hint?: string | undefined;
}

export interface ExtractResult {
  schema: unknown;
  data: unknown;
  raw_text: string;
  tokens: EnhancedPrompt["token_counts"];
  model_used: string;
  fell_back: boolean;
}

export async function runExtractFlow(p: ExtractParams, exec?: Db): Promise<ExtractResult> {
  const route = await resolveModelRoute(p.tenant_id, exec);
  const userContent = p.hint ? `Hint: ${p.hint}\n\nSample:\n${p.sample}` : `Sample:\n${p.sample}`;
  const prompt = await assembleEnhancedPrompt(
    {
      tenant_id: p.tenant_id,
      flow: "extract",
      user_turns: [{ role: "user", content: userContent }],
      max_tokens: route.context_cap,
      model: route.primary,
    },
    exec,
  );
  const { result, model_used, fell_back } = await callWithFallback<{
    schema: unknown;
    data: unknown;
  }>({ flow: "extract", route, prompt }, exec);
  let parsed: { schema: unknown; data: unknown } | undefined;
  if (!result.object && result.text) {
    try {
      parsed = JSON.parse(result.text) as { schema: unknown; data: unknown };
    } catch {
      // Text was not pure JSON — object extraction already attempted by dispatch.
    }
  }
  const obj = (result.object as { schema: unknown; data: unknown } | undefined) ??
    parsed ?? { schema: null, data: null };
  return {
    schema: obj?.schema ?? null,
    data: obj?.data ?? null,
    raw_text: result.text,
    tokens: prompt.token_counts,
    model_used,
    fell_back,
  };
}
