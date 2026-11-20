import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { absolute, workflowAutomationHref } from "@/app/links";
import { ActionButton, Button, ErrorNotice } from "@/components/cockpit/patterns";
import { invalidateWorkflowAutomation } from "@/lib/automation-queries";
import { causeClassLabel } from "@/lib/cause-class";
import { formatDate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { autoPauseRemedy } from "@/lib/schedule-occurrences";

export function workflowSchedulesQuery(workflowId: string) {
  return {
    queryKey: ["workflow", workflowId, "schedules"] as const,
    queryFn: () => apiCall("get", "/v1/schedules", { query: { workflow_id: workflowId } }),
  };
}

export function ScheduleAutoPauseNotice({
  workflowId,
  workflowName,
  canWrite,
}: {
  workflowId: string;
  workflowName: string;
  canWrite: boolean;
}) {
  const { t, locale } = useI18n();
  const client = useQueryClient();
  const query = useQuery(workflowSchedulesQuery(workflowId));
  const schedule = query.data?.schedules.find((entry) => entry.auto_pause) ?? null;
  const resume = useMutation({
    mutationFn: () =>
      apiCall("put", "/v1/schedules/{id}", {
        path: { id: schedule?.id ?? "" },
        body: { paused: false },
      }),
    onSuccess: async () => {
      toast.success(t("schedule.resumed"));
      await invalidateWorkflowAutomation(client, workflowId);
      await client.invalidateQueries({ queryKey: ["workflow", workflowId, "schedules"] });
      await client.invalidateQueries({ queryKey: ["attention"] });
    },
  });
  const pause = schedule?.auto_pause;
  if (!schedule || !pause) return null;
  const remedy = autoPauseRemedy(pause);
  const cause = causeClassLabel(pause.failure_class, t);
  const resumeButton = canWrite ? (
    <ActionButton
      size="sm"
      variant={remedy === "resume" ? "primary" : "outline"}
      pending={resume.isPending}
      onClick={() => resume.mutate()}
      testId="schedule-auto-pause-resume"
    >
      {t("scheduleAutoPause.resume")}
    </ActionButton>
  ) : null;
  return (
    <ErrorNotice
      testId="schedule-auto-pause"
      title={t("scheduleAutoPause.title", { workflow: workflowName })}
      body={
        <>
          {t("scheduleAutoPause.body", {
            count: pause.consecutive_failures,
            date: formatDate(locale, pause.since),
          })}{" "}
          {t(
            remedy === "renew_approval"
              ? "scheduleAutoPause.meansApproval"
              : "scheduleAutoPause.meansResume",
          )}
          {resume.error ? (
            <span className="mt-1 block text-foreground" data-testid="schedule-auto-pause-failed">
              {t("scheduleAutoPause.resumeFailed")}
            </span>
          ) : null}
        </>
      }
      meta={cause.machine ? undefined : cause.text}
      remedy={
        remedy === "renew_approval" ? (
          <Button size="sm" asChild>
            <a
              href={absolute(workflowAutomationHref(workflowId))}
              data-testid="schedule-auto-pause-renew"
            >
              {t("scheduleAutoPause.renew")}
            </a>
          </Button>
        ) : (
          resumeButton
        )
      }
      secondary={remedy === "renew_approval" ? resumeButton : undefined}
      error={resume.error ?? undefined}
    />
  );
}
