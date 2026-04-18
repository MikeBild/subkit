// `extract` flow — unstructured sample → canonical schema + data.
// Thin wrapper around `core/invoke.ts`.

import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { invoke } from "../core/invoke.ts";
import type { EnhancedPrompt } from "../types.ts";

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
  const userContent = p.hint ? `Hint: ${p.hint}\n\nSample:\n${p.sample}` : `Sample:\n${p.sample}`;
  const r = await invoke<ExtractEnvelope>(
    {
      flow: "extract",
      tenant_id: p.tenant_id,
      user_turns: [{ role: "user", content: userContent }],
      schema: ExtractEnvelopeSchema,
    },
    exec,
  );
  const obj = r.object ?? { schema: null, data: null };
  return {
    schema: obj.schema ?? null,
    data: obj.data ?? null,
    raw_text: r.text,
    tokens: r.assembled.prompt.token_counts,
    model_used: r.model_used,
    fell_back: r.fell_back,
  };
}
