import { useId } from "react";
import { Button } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import type { FailedReport } from "./failed-model";

export function FailedReports({
  reports,
  busy = false,
  onResend,
  onDiscard,
  testId = "feedback-unsent",
}: {
  reports: readonly FailedReport[];
  busy?: boolean;
  onResend: (id: string) => void;
  onDiscard: (id: string) => void;
  testId?: string;
}) {
  const { t } = useI18n();
  const labelId = useId();
  if (reports.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby={labelId} data-testid={testId}>
      <p id={labelId} className="text-xs font-semibold text-muted-foreground">
        {t("feedback.unsent.title")}
      </p>
      <ul className="flex flex-col divide-y rounded-md border">
        {reports.map((report, index) => {
          const rowId = `${labelId}-${index}`;
          return (
            <li
              key={report.id}
              className="flex items-center gap-2 px-3 py-2"
              data-testid={`${testId}-${index}`}
              data-failure={report.failure}
            >
              <span className="flex min-w-0 flex-1 flex-col" id={rowId}>
                <span className="truncate text-sm">{report.excerpt}</span>
                <span className="text-xs text-destructive-ink">
                  {t(`feedback.unsent.reason.${report.failure}`)}
                </span>
              </span>
              {report.canResend ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  aria-describedby={rowId}
                  onClick={() => onResend(report.id)}
                  data-testid={`${testId}-${index}-resend`}
                >
                  {t("feedback.unsent.resend")}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-describedby={rowId}
                onClick={() => onDiscard(report.id)}
                data-testid={`${testId}-${index}-discard`}
              >
                {t("feedback.unsent.discard")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
