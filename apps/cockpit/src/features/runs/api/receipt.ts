import { z } from "zod";

export const RunReceiptSchema = z.object({
  source_quote: z.string().trim().min(1).max(400).nullish().catch(null),
});

export function runReceiptQuote(execution: unknown): string | null {
  const parsed = RunReceiptSchema.safeParse(execution);
  return parsed.success ? (parsed.data.source_quote ?? null) : null;
}
