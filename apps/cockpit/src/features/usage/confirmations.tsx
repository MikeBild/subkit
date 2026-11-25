import { ActionButton, Section, TileSkeleton } from "@/components/cockpit/patterns";
import type { ConfirmationSummary, Read } from "@/features/usage/model/operations-figures";
import { useI18n } from "@/lib/i18n-context";

export function confirmationLineParts(summary: ConfirmationSummary): {
  perTurn: number | null;
  medianPerRun: number | null;
  covered: number;
} {
  return {
    perTurn: summary.turns > 0 ? summary.perTurn : null,
    medianPerRun: summary.runs > 0 ? summary.medianPerRun : null,
    covered: summary.covered,
  };
}

export function ConfirmationsSection({
  read,
  pending = false,
  onRetry,
}: {
  read: Read<ConfirmationSummary>;
  pending?: boolean;
  onRetry: () => void;
}) {
  const { t, locale } = useI18n();
  const decimal = new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US", {
    maximumFractionDigits: 2,
  });
  const summary = read.state === "answered" ? read.value : null;
  const body = () => {
    if (pending) return <TileSkeleton />;
    if (summary === null)
      return (
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="usage-confirmations-unreadable"
        >
          <span>{t("overview.operations.unreadable")}</span>
          <ActionButton
            variant="ghost"
            size="sm"
            onClick={onRetry}
            testId="usage-confirmations-retry"
          >
            {t("session.retry")}
          </ActionButton>
        </p>
      );
    if (summary.asked === 0 && summary.covered === 0)
      return (
        <p className="text-sm text-muted-foreground" data-testid="usage-confirmations-none">
          {t("usage.confirm.none")}
        </p>
      );
    const parts = confirmationLineParts(summary);
    const line = [
      parts.perTurn === null
        ? null
        : t("usage.confirm.perTurn", { value: decimal.format(parts.perTurn) }),
      parts.medianPerRun === null
        ? null
        : t("usage.confirm.perRun", { value: decimal.format(parts.medianPerRun) }),
      t("usage.confirm.covered", { count: decimal.format(parts.covered) }),
    ].filter((part): part is string => part !== null);
    return (
      <>
        <p className="text-sm" data-testid="usage-confirmations-line">
          {line.join(" · ")}
        </p>
        {summary.tools.length > 0 ? (
          <details className="text-sm" data-testid="usage-confirmations-tools">
            <summary className="cursor-pointer text-muted-foreground">
              {t("usage.confirm.byTool")}
            </summary>
            <ul className="mt-2 divide-y rounded-lg border">
              {summary.tools.map((row) => (
                <li
                  key={row.tool}
                  className="flex items-center justify-between gap-4 px-4 py-2"
                  data-testid="usage-confirmations-tool"
                  data-tool={row.tool}
                >
                  <span className="min-w-0 truncate font-mono text-xs">{row.tool}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {t("usage.confirm.toolRow", {
                      asked: decimal.format(row.asked),
                      covered: decimal.format(row.covered),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </>
    );
  };
  return (
    <Section label={t("usage.confirm.title")} testId="usage-confirmations">
      {body()}
    </Section>
  );
}
