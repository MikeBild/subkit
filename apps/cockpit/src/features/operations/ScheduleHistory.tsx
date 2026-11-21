import { Pill } from "@ui/atoms/pill";
import { useI18n as useUiI18n } from "@ui/lib/ui-context";
import { EmptyState } from "@ui/molecules/empty-state";
import { Timeline } from "@ui/organisms/timeline";
import { CalendarClock, CalendarX2, Clock3, PauseCircle, Play } from "lucide-react";
import { Button } from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { occurrenceLabel, occurrenceTone } from "./schedule-model";
import { useScheduleOccurrences } from "./use-operations";

const icon = { ran: Play, late: Clock3, skipped: CalendarX2, held: PauseCircle } as const;

export function ScheduleHistory({
  subject,
  scheduled,
  onOpenRun,
}: {
  subject: { kind: "workflow" | "task"; id: string };
  scheduled: boolean;
  onOpenRun?: (runId: string) => void;
}) {
  const { t, locale } = useI18n();
  const { lang } = useUiI18n();
  const data = useScheduleOccurrences(subject);
  const items = data.items;
  if (data.pending)
    return <div className="mt-6 h-24 animate-pulse rounded-xl bg-muted" aria-hidden />;
  if (data.failed)
    return (
      <EmptyState
        icon={CalendarClock}
        title={t("scheduleHistory.failed")}
        action={
          <Button variant="outline" size="sm" onClick={data.retry} data-testid="schedule-retry">
            {t("session.retry")}
          </Button>
        }
      />
    );
  if (!scheduled && !items.length)
    return (
      <EmptyState icon={CalendarClock} title={t("ops.sched.none")} text={t("ops.sched.noneText")} />
    );
  if (!items.length)
    return (
      <EmptyState icon={CalendarClock} title={t("ops.sched.title")} text={t("ops.sched.empty")} />
    );
  const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const hm = (iso: string) => clock.format(new Date(iso));
  return (
    <div data-testid="schedule-history-timeline">
      <Timeline
        lang={lang}
        time={(iso) => t("ops.sched.due", { time: hm(iso) })}
        items={items.map((o) => ({
          id: o.id,
          at: o.due,
          tone: occurrenceTone(o),
          icon: icon[o.state],
          content: (
            <div
              className="flex flex-col gap-1"
              data-testid={`schedule-occurrence-${o.state}`}
              data-outcome={o.outcome ?? undefined}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={occurrenceTone(o)}>
                  {t(`ops.sched.state.${occurrenceLabel(o)}` as TranslationKey)}
                </Pill>
                <span className="text-xs text-muted-foreground">
                  {[
                    o.start
                      ? t("ops.sched.started", { time: hm(o.start) })
                      : o.reason
                        ? null
                        : t("ops.sched.notStarted"),
                    o.coversText,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {o.runId && onOpenRun ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => onOpenRun(o.runId ?? "")}
                    data-testid={`schedule-occurrence-open-${o.id}`}
                  >
                    {t("scheduleHistory.openRun")}
                  </Button>
                ) : null}
              </div>
              {o.reason ? <p className="text-sm">{o.reason}</p> : null}
            </div>
          ),
        }))}
      />
      {data.hasOlder ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          disabled={data.loadingOlder}
          onClick={data.older}
          data-testid="schedule-history-older"
        >
          {t("scheduleHistory.older")}
        </Button>
      ) : null}
    </div>
  );
}
