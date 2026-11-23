import { useQuery } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { LiveIndicator } from "@/components/cockpit/live-indicator";
import { Button } from "@/components/cockpit/patterns";
import type { Translate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { type LiveRunStep, liveRunStep } from "./schedule-model";

export function liveRunSentence(t: Translate, step: LiveRunStep | null): string {
  if (!step) return t("ops.sched.live.starting");
  return step.attempt > 1
    ? t("ops.sched.live.retry", { step: step.stepKey, attempt: String(step.attempt) })
    : t("ops.sched.live.step", { step: step.stepKey });
}

export function useLiveRunStep(executionId: string): LiveRunStep | null {
  const steps = useQuery({
    queryKey: ["run-steps", executionId],
    queryFn: () => apiCall("get", "/v1/executions/{id}/steps", { path: { id: executionId } }),
  });
  return liveRunStep(steps.data?.items ?? []);
}

export function LiveScheduleRun({
  executionId,
  onOpenRun,
  testId,
}: {
  executionId: string;
  onOpenRun?: (runId: string) => void;
  testId: string;
}) {
  const { t } = useI18n();
  const step = useLiveRunStep(executionId);
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
      data-testid={testId}
      data-run={executionId}
    >
      <LiveIndicator testId={`${testId}-indicator`} />
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="min-w-0"
        data-testid={`${testId}-step`}
      >
        {liveRunSentence(t, step)}
      </span>
      {onOpenRun ? (
        <Button
          variant="ghost"
          size="sm"
          className="ms-auto"
          onClick={() => onOpenRun(executionId)}
          data-testid={`${testId}-open`}
        >
          {t("scheduleHistory.openRun")}
        </Button>
      ) : null}
    </div>
  );
}
