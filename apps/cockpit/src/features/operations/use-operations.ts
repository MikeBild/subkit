import { useInfiniteQuery } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { useI18n } from "@/lib/i18n-context";
import { occurrenceSentenceKey } from "@/lib/schedule-occurrences";
import { type Occurrence, sortOccurrences, toOccurrence } from "./schedule-model";

const OCCURRENCE_PAGE = 30;

export interface OccurrenceView extends Occurrence {
  reason: string | null;
  coversText: string | null;
}

export function useScheduleOccurrences(subject: { kind: "workflow" | "task"; id: string }) {
  const { t, tn } = useI18n();
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
          query: { limit: OCCURRENCE_PAGE, ...(pageParam ? { before: pageParam } : {}) },
        },
      ),
    getNextPageParam: (page) => page.next_before,
  });
  const raw = query.data?.pages.flatMap((page) => page.items) ?? [];
  const items: OccurrenceView[] = sortOccurrences(raw.map(toOccurrence)).map((occurrence) => {
    const source = raw.find((entry) => entry.id === occurrence.id);
    return {
      ...occurrence,
      reason: source && occurrence.reasonCode ? t(occurrenceSentenceKey(source)) : null,
      coversText: occurrence.covers > 0 ? tn("scheduleHistory.covers", occurrence.covers) : null,
    };
  });
  return {
    items,
    pending: query.isPending,
    failed: Boolean(query.error) && items.length === 0,
    retry: () => void query.refetch(),
    hasOlder: query.hasNextPage,
    loadingOlder: query.isFetchingNextPage,
    older: () => void query.fetchNextPage(),
  };
}
