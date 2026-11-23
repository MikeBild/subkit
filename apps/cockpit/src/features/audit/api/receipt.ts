import { z } from "zod";

const Quote = z.string().trim().min(1).max(400);
const OptionalQuote = Quote.nullish().catch(null);

export const AuditReceiptSchema = z.object({
  metadata: z
    .object({ source_quote: OptionalQuote, rule_quote: OptionalQuote, because: OptionalQuote })
    .nullish()
    .catch(null),
});

export function auditReceiptQuote(entry: unknown): string | null {
  const parsed = AuditReceiptSchema.safeParse(entry);
  if (!parsed.success) return null;
  const metadata = parsed.data.metadata;
  return metadata?.source_quote ?? metadata?.rule_quote ?? metadata?.because ?? null;
}
