// `extract` flow — unstructured sample → canonical schema + data.

import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { assembleEnhancedPrompt } from "../context.ts";
import { callWithFallback, resolveModelRoute } from "../provider.ts";
import type { EnhancedPrompt } from "../types.ts";

// Extract envelope — only the outer shape is validated; the inner
// `schema` is whatever the model discovered from the sample.
const ExtractEnvelopeSchema = z.object({
  schema: z.unknown(),
  data: z.unknown(),
});

type ExtractEnvelope = z.infer<typeof ExtractEnvelopeSchema>;

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
  const { result, model_used, fell_back } = await callWithFallback<ExtractEnvelope>(
    { flow: "extract", route, prompt, schema: ExtractEnvelopeSchema },
    exec,
  );
  const obj = result.object ?? { schema: null, data: null };
  return {
    schema: obj.schema ?? null,
    data: obj.data ?? null,
    raw_text: result.text,
    tokens: prompt.token_counts,
    model_used,
    fell_back,
  };
}
