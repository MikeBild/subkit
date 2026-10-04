import { z } from "@hono/zod-openapi";
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

export const StructuredSummarySchema = z
  .object({
    summary: z.string(),
    key_points: z.array(z.string()).max(10).optional(),
    warnings: z.array(z.string()).max(10).optional(),
  })
  .openapi("StructuredSummary");

export type StructuredSummary = z.infer<typeof StructuredSummarySchema>;

export interface StructuredSummarizeResult extends SummarizeResult {
  object: StructuredSummary;
}

export async function runStructuredSummarizeFlow(
  p: SummarizeParams,
  exec?: Db,
): Promise<StructuredSummarizeResult> {
  const r = await invoke<StructuredSummary>(
    {
      flow: "summarize",
      tenant_id: p.tenant_id,
      user_turns: [{ role: "user", content: p.prompt }],
      schema: StructuredSummarySchema,
    },
    exec,
  );
  if (!r.object) {
    throw new Error("summarize flow: provider returned empty object");
  }
  return {
    object: r.object,
    summary: r.object.summary,
    raw_text: r.text,
    tokens: r.assembled.prompt.token_counts,
    model_used: r.model_used,
    fell_back: r.fell_back,
  };
}
