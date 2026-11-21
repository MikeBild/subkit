import { useRouter } from "@tanstack/react-router";
import { IconTile } from "@ui/atoms/icon-tile";
import { cn } from "@ui/lib/utils";
import { IconButton } from "@ui/molecules/icon-button";
import { Check, ChevronRight, MessageSquare, Play, Plug, Terminal, Users, X } from "lucide-react";
import { absolute } from "@/app/links";
import { SectionHeading } from "@/components/cockpit/patterns";
import { ServiceIcon } from "@/features/connectors";
import {
  checklistView,
  type StartStepIcon,
  startStepIcon,
} from "@/features/first-steps/model/first-steps";
import { useI18n } from "@/lib/i18n-context";
import { namedService } from "@/lib/service-icons";

const STEP_ICONS: Record<StartStepIcon, typeof Plug> = {
  plug: Plug,
  message: MessageSquare,
  play: Play,
  users: Users,
  terminal: Terminal,
};

export interface StartStep {
  id?: string;
  title: string;
  line: string;
  href: string;
  done: boolean;
  service?: string;
}

export function FirstSteps({
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
  const d = checklistView(steps, hidden);
  if (!d.visible) return null;
  return (
    <section
      className="rounded-xl border p-6"
      data-slot="start-checklist"
      data-testid={testId}
      aria-labelledby={`${testId}-title`}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <SectionHeading id={`${testId}-title`} className="font-semibold">
            {t("onboarding.checklist.title")}
          </SectionHeading>
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">
            {t("onboarding.checklist.progress", { done: d.done, total: d.total })}
          </p>
        </div>
        <IconButton
          type="button"
          label={t("onboarding.checklist.hide")}
          className="-mr-2 -mt-2 size-8"
          onClick={onHide}
          data-testid={`${testId}-hide`}
        >
          <X className="size-4" />
        </IconButton>
      </div>
      <div
        className="mb-4 h-2 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-label={t("onboarding.checklist.title")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={d.percent}
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${d.percent}%` }} />
      </div>
      <ul className="divide-y" data-slot="start-steps">
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
                aria-current={index === d.next ? "step" : undefined}
                data-done={step.done || undefined}
                data-testid={`${testId}-step-${index}`}
                className="flex w-full items-center justify-start gap-3 rounded-control px-2 py-3 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded border">
                  {step.done && <Check className="size-4 text-success-ink" aria-hidden />}
                </span>
                {step.service ? (
                  <ServiceIcon service={namedService(step.service)} tile="md" />
                ) : (
                  <IconTile icon={STEP_ICONS[startStepIcon(step.id)]} size="md" />
                )}
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-sm font-medium",
                      step.done && "text-muted-foreground",
                    )}
                  >
                    {step.title}
                  </span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {step.line}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0" aria-hidden />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
