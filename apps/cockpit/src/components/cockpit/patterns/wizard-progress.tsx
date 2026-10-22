import { Check } from "lucide-react";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

export function WizardProgress({
  steps,
  current,
  testId,
}: {
  steps: readonly string[];
  current: number;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <ol
      className="flex items-center gap-2 text-xs"
      aria-label={t("wizard.progress", { step: current + 1, total: steps.length })}
      data-slot="wizard-progress"
      data-testid={testId}
    >
      {steps.map((label, index) => (
        <li key={label} className="contents">
          <span
            className={cn(
              "flex items-center gap-2",
              index === current
                ? "font-medium text-foreground"
                : index < current
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-muted-foreground",
            )}
            aria-current={index === current ? "step" : undefined}
          >
            <span
              className={cn(
                "inline-grid size-5 place-items-center rounded-full border [&_svg]:size-3",
                index === current && "border-foreground",
                index < current && "border-emerald-500",
              )}
            >
              {index < current ? <Check aria-hidden="true" /> : index + 1}
            </span>
            {label}
          </span>
          {index < steps.length - 1 ? (
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}
