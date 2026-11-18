import { Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { FAMILY_UI_VERSION } from "@/components/family-ui";
import { LOCALES } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { SegmentedControl } from "./segmented-control";

export function StandalonePage({
  title,
  lead,
  busy = false,
  testId,
  children,
}: {
  title: string;
  lead?: ReactNode;
  busy?: boolean;
  testId: string;
  children?: ReactNode;
}) {
  const { t, locale, setPreference } = useI18n();
  return (
    <main
      className="min-h-full bg-background px-4 py-6 sm:px-6 sm:py-10"
      data-family-surface="auth"
      data-family-contract-version={FAMILY_UI_VERSION}
      data-slot="standalone-page"
      data-testid={testId}
      aria-busy={busy || undefined}
    >
      <div className="mx-auto flex w-full max-w-[480px] flex-col gap-10">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2" data-testid="standalone-wordmark">
            <span
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground"
            >
              <Workflow className="size-4" />
            </span>
            <span className="truncate text-sm font-semibold">{t("app.name")}</span>
          </span>
          <SegmentedControl
            label={t("account.language")}
            value={locale}
            onValueChange={(next) => {
              const chosen = LOCALES.find((candidate) => candidate === next);
              if (chosen) setPreference(chosen);
            }}
            testId="standalone-language"
            options={[
              { value: "de", label: t("language.native.de"), testId: "standalone-language-de" },
              { value: "en", label: t("language.native.en"), testId: "standalone-language-en" },
            ]}
          />
        </div>
        <div className="flex flex-col gap-6">
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
        </div>
      </div>
    </main>
  );
}
