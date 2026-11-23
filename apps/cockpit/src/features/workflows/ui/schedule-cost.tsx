import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { FactList } from "@/components/cockpit/patterns";
import {
  type ScheduleCostProjection,
  scheduleCostWords,
} from "@/features/workflows/model/schedule-cost";
import { useI18n } from "@/lib/i18n-context";
import { useDebouncedValue } from "@/lib/use-debounced-value";

export function ScheduleCostValue({
  projection,
  testId,
}: {
  projection: ScheduleCostProjection;
  testId?: string;
}) {
  const { t, tn, locale } = useI18n();
  const words = scheduleCostWords(projection, t, tn, locale);
  return (
    <span className="flex flex-col gap-0.5" data-testid={testId}>
      <span className={words.estimated ? "font-medium tabular-nums" : "text-muted-foreground"}>
        {words.amount}
      </span>
      {words.basis ? <span className="text-muted-foreground text-xs">{words.basis}</span> : null}
    </span>
  );
}

export function ScheduleCostPreview({
  workflowId,
  cron,
  timezone,
  enabled,
}: {
  workflowId: string;
  cron: string;
  timezone: string;
  enabled: boolean;
}) {
  const { t } = useI18n();
  const settled = useDebouncedValue(cron, 250);
  const query = useQuery({
    queryKey: ["workflow", workflowId, "schedule-cost", settled, timezone],
    enabled,
    queryFn: () =>
      apiCall("get", "/v1/workflows/{id}/schedule-cost", {
        path: { id: workflowId },
        query: { cron: settled, timezone },
      }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  if (query.isError) return null;
  return (
    <div aria-live="polite" data-testid="schedule-cost-preview">
      <FactList
        loading={query.isPending ? 1 : false}
        items={
          query.data
            ? [
                {
                  label: t("schedule.cost.label"),
                  value: <ScheduleCostValue projection={query.data} />,
                  help: t("schedule.cost.help"),
                },
              ]
            : []
        }
      />
    </div>
  );
}
