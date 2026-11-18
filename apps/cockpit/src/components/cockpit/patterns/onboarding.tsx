import { useRouter } from "@tanstack/react-router";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { absolute } from "@/app/links";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { SectionHeading } from "./section";

export function OnboardingFrame({
  lead,
  children,
  testId,
}: {
  lead: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-6 pb-6" data-slot="onboarding" data-testid={testId}>
      <p className="max-w-2xl text-sm text-muted-foreground" data-slot="onboarding-lead">
        {lead}
      </p>
      {children}
    </div>
  );
}

export interface StartStep {
  title: string;
  line: string;
  href: string;
  done: boolean;
}

export function StartChecklist({
  steps,
  hidden,
  onHide,
  testId = "start-checklist",
}: {
  steps: readonly StartStep[];
  hidden: boolean;
  onHide(): void;
  testId?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const done = steps.filter((step) => step.done).length;
  if (hidden || steps.length === 0 || done === steps.length) return null;
  const next = steps.findIndex((step) => !step.done);
  return (
    <section
      className="rounded-lg border p-4"
      data-slot="start-checklist"
      data-testid={testId}
      aria-labelledby={`${testId}-title`}
    >
      <div className="flex items-center gap-3">
        <SectionHeading id={`${testId}-title`}>{t("onboarding.checklist.title")}</SectionHeading>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {t("onboarding.checklist.progress", { done, total: steps.length })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onHide}
          data-testid={`${testId}-hide`}
        >
          {t("onboarding.checklist.hide")}
        </Button>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-muted" aria-hidden="true">
        <div
          className="h-1.5 rounded-full bg-emerald-500"
          style={{ width: `${(done / steps.length) * 100}%` }}
        />
      </div>
      <ol className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5" data-slot="start-steps">
        {steps.map((step, index) => {
          const href = absolute(step.href);
          return (
            <li key={step.title}>
              <a
                href={href}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
                    return;
                  event.preventDefault();
                  router.history.push(href);
                }}
                aria-current={index === next ? "step" : undefined}
                data-done={step.done || undefined}
                data-testid={`${testId}-step-${index}`}
                className={cn(
                  "flex h-full gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:flex-col xl:gap-2",
                  index === next && "border-foreground/30",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-grid size-6 shrink-0 place-items-center rounded-full border text-xs font-medium tabular-nums [&_svg]:size-3.5",
                    step.done && "border-emerald-500 text-emerald-600",
                  )}
                >
                  {step.done ? <Check /> : index + 1}
                </span>
                <span className="min-w-0">
                  <span
                    className={cn(
                      "block text-sm font-medium",
                      step.done && "text-muted-foreground line-through",
                    )}
                  >
                    {step.title}
                  </span>
                  <span className="block text-xs text-muted-foreground">{step.line}</span>
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
