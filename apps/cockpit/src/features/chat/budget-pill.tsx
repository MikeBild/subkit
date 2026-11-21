import { absolute, usageHref } from "@/app/links";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

export function BudgetPill({ budget }: { budget: "tightening" | "critical" | null }) {
  const { t } = useI18n();
  if (!budget) return null;
  return (
    <a
      href={absolute(usageHref())}
      data-testid="chat-budget"
      data-budget={budget}
      className={cn(
        "mt-2 inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2.5 text-xs tabular-nums underline-offset-4 hover:underline",
        budget === "critical"
          ? "border-destructive/40 text-destructive"
          : "border-warning/40 bg-warning/10 text-warning",
      )}
    >
      {t(budget === "critical" ? "chat.budget.critical" : "chat.budget.tightening")}
    </a>
  );
}
