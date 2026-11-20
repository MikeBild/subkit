import { useInfiniteQuery } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import {
  ActionButton,
  DataState,
  Section,
  Timeline,
  type TimelineGroup,
} from "@/components/cockpit/patterns";
import { useOpenRunSheet } from "@/components/cockpit/run-sheet";
import { formatDate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  groupOccurrencesByDay,
  occurrenceCovers,
  occurrenceSentenceKey,
  occurrenceTone,
} from "@/lib/schedule-occurrences";

const PAGE = 30;

export function ScheduleHistory({
  subject,
}: {
  subject: { kind: "workflow" | "task"; id: string };
}) {
  const { t, tn, locale } = useI18n();
  const sheets = useOpenRunSheet();
  const query = useInfiniteQuery({
    queryKey: [subject.kind, subject.id, "schedule-occurrences"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiCall(
        "get",
        subject.kind === "workflow"
          ? "/v1/workflows/{id}/schedule-occurrences"
          : "/v1/tasks/{id}/schedule-occurrences",
        {
          path: { id: subject.id },
          query: { limit: PAGE, ...(pageParam ? { before: pageParam } : {}) },
        },
      ),
    getNextPageParam: (page) => page.next_before,
  });
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const occurrences = query.data?.pages.flatMap((page) => page.items) ?? [];
  const groups: TimelineGroup[] = groupOccurrencesByDay(occurrences, (instant) =>
    formatDate(locale, instant),
  ).map((day) => ({
    label: day.day,
    items: day.items.map((occurrence) => {
      const covers = occurrenceCovers(occurrence);
      const runId = subject.kind === "workflow" ? occurrence.execution_id : null;
      return {
        id: occurrence.id,
        tone: occurrenceTone(occurrence.state),
        title: t(occurrenceSentenceKey(occurrence)),
        time: time.format(new Date(occurrence.due_at)),
        dateTime: occurrence.due_at,
        meta: covers > 0 ? tn("scheduleHistory.covers", covers) : undefined,
        label: t("scheduleHistory.openRun"),
        testId: `schedule-occurrence-${occurrence.state}`,
        ...(runId ? { onOpen: () => sheets.run(runId) } : {}),
      };
    }),
  }));
  return (
    <Section label={t("scheduleHistory.title")} testId="schedule-history">
      {query.isPending ? (
        <DataState state="loading" testId="schedule-history-loading" />
      ) : query.error && occurrences.length === 0 ? (
        <DataState
          state="error"
          line={t("scheduleHistory.failed")}
          error={query.error}
          onRetry={() => void query.refetch()}
          testId="schedule-history-error"
        />
      ) : occurrences.length === 0 ? (
        <DataState
          state="empty"
          line={t("scheduleHistory.empty")}
          testId="schedule-history-empty"
        />
      ) : (
        <>
          <Timeline groups={groups} testId="schedule-history-timeline" />
          {query.hasNextPage ? (
            <div>
              <ActionButton
                variant="outline"
                size="sm"
                pending={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
                testId="schedule-history-older"
              >
                {t("scheduleHistory.older")}
              </ActionButton>
            </div>
          ) : null}
        </>
      )}
    </Section>
  );
}
