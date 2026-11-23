import { Quote } from "lucide-react";
import { useI18n } from "@/lib/i18n-context";

export function receiptText(quote: string | null | undefined): string | null {
  const text = quote?.trim() ?? "";
  return text.length > 0 ? text : null;
}

export function Receipt({
  quote,
  testId = "receipt",
}: {
  quote: string | null | undefined;
  testId?: string;
}) {
  const { t } = useI18n();
  const text = receiptText(quote);
  if (!text) return null;
  return (
    <figure
      className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm"
      data-slot="receipt"
      data-testid={testId}
    >
      <Quote aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <figcaption className="text-xs font-medium text-muted-foreground">
          {t("receipt.youSaid")}
        </figcaption>
        <blockquote className="[overflow-wrap:anywhere]" data-testid={`${testId}-quote`}>
          {t("receipt.quote", { quote: text })}
        </blockquote>
      </div>
    </figure>
  );
}
