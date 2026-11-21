import { Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { StandaloneControls } from "@/app/standalone-controls";
import { FAMILY_UI_VERSION } from "@/components/family-ui";
import { useI18n } from "@/lib/i18n-context";

export interface StandaloneActions {
  back?: ReactNode;
  primary?: ReactNode;
}

export function StandalonePage({
  title,
  lead,
  busy = false,
  testId,
  actions,
  children,
}: {
  title: string;
  lead?: ReactNode;
  busy?: boolean;
  testId: string;
  actions?: StandaloneActions;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <main
      className="flex min-h-full flex-col gap-10 bg-background px-4 py-4 sm:px-8"
      data-family-surface="auth"
      data-family-contract-version={FAMILY_UI_VERSION}
      data-slot="standalone-page"
      data-testid={testId}
      aria-busy={busy || undefined}
    >
      <header
        className="flex min-h-10 items-center justify-between gap-2"
        data-slot="standalone-header"
      >
        <span className="flex min-w-0 items-center gap-2" data-testid="standalone-wordmark">
          <span
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground"
          >
            <Workflow className="size-4" />
          </span>
          <span className="truncate text-sm font-semibold">{t("app.name")}</span>
        </span>
        <StandaloneControls />
      </header>
      <div className="mx-auto flex w-full max-w-[480px] flex-col gap-6 sm:pt-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold leading-8 tracking-[-0.02em] [overflow-wrap:anywhere]">
            {title}
          </h1>
          {lead ? (
            <div className="text-sm leading-5 text-muted-foreground" data-slot="standalone-lead">
              {lead}
            </div>
          ) : null}
        </div>
        {children}
        {actions ? (
          <div
            className="flex min-h-10 flex-wrap items-center gap-2 border-t pt-6"
            data-slot="standalone-actions"
            data-testid="standalone-actions"
          >
            {actions.back}
            {actions.primary ? (
              <div className="ml-auto flex flex-wrap items-center gap-2">{actions.primary}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
