import { z } from "zod";

const Quote = z.string().trim().min(1).max(400);

export const AuditReceiptSchema = z.object({
  source_quote: Quote.nullish().catch(null),
  metadata: z
    .object({ source_quote: Quote.nullish().catch(null) })
    .nullish()
    .catch(null),
});

export function auditReceiptQuote(entry: unknown): string | null {
  const parsed = AuditReceiptSchema.safeParse(entry);
  if (!parsed.success) return null;
  return parsed.data.source_quote ?? parsed.data.metadata?.source_quote ?? null;
}
