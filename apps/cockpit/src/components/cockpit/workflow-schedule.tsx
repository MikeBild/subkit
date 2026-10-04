import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { SelectField, TextField } from "@/components/cockpit/form-field";
import {
  ActionButton,
  ActionMenu,
  ConfirmDialog,
  DataState,
  FactList,
  FormDialog,
  SegmentedControl,
} from "@/components/cockpit/patterns";
import { invalidateWorkflowAutomation } from "@/lib/automation-queries";
import { cronWords } from "@/lib/cron-words";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  cronToRhythm,
  DEFAULT_RHYTHM,
  type Rhythm,
  type RhythmValue,
  rhythmToCron,
  validTime,
} from "@/lib/schedule-rhythm";

type ScheduleEntry = components["schemas"]["ScheduleEntry"];
type ScheduleList = components["schemas"]["ScheduleListResponse"];

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function useWorkflowSchedule(workflowId: string) {
  const live = useLiveQueryOptions();
  const query = useQuery({
    queryKey: ["workflow", workflowId, "schedules"],
    queryFn: () =>
      apiRequest<ScheduleList>(`/v1/schedules?workflow_id=${encodeURIComponent(workflowId)}`),
    ...live,
  });
  const schedule = Array.isArray(query.data?.schedules)
    ? (query.data.schedules.find((entry) => entry.workflow_id === workflowId) ?? null)
    : null;
  return { query, schedule };
}

function ScheduleDialog({
  open,
  onOpenChange,
  workflowId,
  schedule,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  workflowId: string;
  schedule: ScheduleEntry | null;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [value, setValue] = useState<RhythmValue>(
    () => (schedule ? cronToRhythm(schedule.cron) : null) ?? DEFAULT_RHYTHM,
  );
  const [error, setError] = useState<string | null>(null);
  const zone = schedule?.timezone ?? localZone();
  const save = useMutation({
    mutationFn: (cron: string) =>
      schedule
        ? apiRequest(`/v1/schedules/${encodeURIComponent(schedule.id)}`, {
            method: "PUT",
            body: JSON.stringify({ cron, timezone: zone }),
          })
        : apiRequest("/v1/schedules", {
            method: "POST",
            body: JSON.stringify({
              workflow_id: workflowId,
              cron,
              timezone: zone,
              execution_mode: "prod",
            }),
          }),
    onSuccess: async () => {
      toast.success(t(schedule ? "schedule.saved" : "schedule.created"));
      onOpenChange(false);
      await invalidateWorkflowAutomation(client, workflowId);
      await client.invalidateQueries({ queryKey: ["workflow-invocation", workflowId] });
    },
    onError: () => setError(t("schedule.saveFailed")),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(schedule ? "schedule.editTitle" : "schedule.createTitle")}
      submit={{ label: t(schedule ? "common.save" : "schedule.create"), pending: save.isPending }}
      onSubmit={() => {
        if (!validTime(value.time)) return setError(t("schedule.timeInvalid"));
        setError(null);
        save.mutate(rhythmToCron(value));
      }}
      error={error}
      testId="schedule-dialog"
    >
      <FactList
        items={[{ label: t("schedule.zone"), value: zone, help: t("schedule.zoneHelp") }]}
      />
      <ScheduleFields value={value} onChange={setValue} invalid={Boolean(error)} />
    </FormDialog>
  );
}

export function ScheduleFields({
  value,
  onChange,
  invalid,
}: {
  value: RhythmValue;
  onChange(value: RhythmValue): void;
  invalid?: boolean;
}) {
  const { t, locale } = useI18n();
  const setValue = onChange;
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(2023, 0, 1 + index));
    return {
      value: String(index),
      label: new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
        weekday: "long",
        timeZone: "UTC",
      }).format(date),
    };
  });
  const ordered = [...days.slice(1), days[0]].filter(
    (day): day is { value: string; label: string } => Boolean(day),
  );
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t("schedule.rhythm")}</span>
        <SegmentedControl
          label={t("schedule.rhythm")}
          value={value.rhythm}
          onValueChange={(rhythm) => setValue({ ...value, rhythm: rhythm as Rhythm })}
          testId="schedule-rhythm"
          options={[
            { value: "daily", label: t("schedule.daily"), testId: "schedule-rhythm-daily" },
            { value: "weekly", label: t("schedule.weekly"), testId: "schedule-rhythm-weekly" },
            { value: "monthly", label: t("schedule.monthly"), testId: "schedule-rhythm-monthly" },
          ]}
        />
      </div>
      {value.rhythm === "weekly" ? (
        <SelectField
          id="schedule-weekday"
          label={t("schedule.weekday")}
          value={String(value.weekday)}
          onChange={(day) => setValue({ ...value, weekday: Number(day) })}
          options={ordered}
        />
      ) : null}
      <TextField
        id="schedule-time"
        type="time"
        label={t("schedule.time")}
        value={value.time}
        onChange={(time) => setValue({ ...value, time })}
        invalid={Boolean(invalid)}
      />
    </>
  );
}

export function WorkflowScheduleSection({
  workflowId,
  workflowName,
  nextFireAt,
  canWrite,
  canChat,
}: {
  workflowId: string;
  workflowName: string;
  nextFireAt: string | null;
  canWrite: boolean;
  canChat: boolean;
}) {
  const { t, locale, dateTime } = useI18n();
  const client = useQueryClient();
  const { query, schedule } = useWorkflowSchedule(workflowId);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const refresh = async () => {
    await invalidateWorkflowAutomation(client, workflowId);
    await client.invalidateQueries({ queryKey: ["workflow-invocation", workflowId] });
  };
  const pause = useMutation({
    mutationFn: (paused: boolean) =>
      apiRequest(`/v1/schedules/${encodeURIComponent(schedule?.id ?? "")}`, {
        method: "PUT",
        body: JSON.stringify({ paused }),
      }),
    onSuccess: async (_result, paused) => {
      toast.success(t(paused ? "schedule.paused" : "schedule.resumed"));
      await refresh();
    },
    onError: () => toast.error(t("common.actionFailed")),
  });
  const remove = useMutation({
    mutationFn: () =>
      apiRequest(`/v1/schedules/${encodeURIComponent(schedule?.id ?? "")}`, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success(t("schedule.deleted"));
      setDeleting(false);
      await refresh();
    },
    onError: () => toast.error(t("common.actionFailed")),
  });
  if (query.isPending) return <DataState state="loading" />;
  if (query.error)
    return (
      <DataState
        state="error"
        line={t("schedule.loadFailed")}
        onRetry={() => void query.refetch()}
        testId="schedule-failed"
      />
    );
  const dialog = canWrite ? (
    <ScheduleDialog
      key={schedule?.id ?? "new"}
      open={editing}
      onOpenChange={setEditing}
      workflowId={workflowId}
      schedule={schedule}
    />
  ) : null;
  if (!schedule)
    return (
      <>
        <DataState
          state="empty"
          line={t("schedule.none")}
          testId="schedule-none"
          action={
            <span className="flex flex-wrap gap-2">
              {canWrite ? (
                <ActionButton size="sm" onClick={() => setEditing(true)} testId="schedule-create">
                  {t("schedule.createTitle")}
                </ActionButton>
              ) : null}
              {canChat ? (
                <ActionMenu
                  size="sm"
                  items={[
                    {
                      label: t("schedule.inChat"),
                      href: absolute(
                        chatNewHref({
                          workflowId,
                          prompt: t("schedule.chatPrompt", { name: workflowName }),
                        }),
                      ),
                      testId: "schedule-chat",
                    },
                  ]}
                />
              ) : null}
            </span>
          }
        />
        {dialog}
      </>
    );
  const words = cronWords(schedule.cron, t, LOCALE_TAGS[locale]);
  return (
    <div className="flex flex-col gap-3" data-testid="workflow-schedule">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <FactList
            items={[
              {
                label: t("schedule.rhythm"),
                value: words === schedule.cron ? words : `${words} · ${schedule.cron}`,
                testId: "schedule-rhythm-fact",
              },
              {
                label: t("schedule.next"),
                value: schedule.paused
                  ? t("schedule.isPaused")
                  : nextFireAt
                    ? dateTime(nextFireAt)
                    : "—",
                testId: "schedule-next-fact",
              },
              { label: t("schedule.zone"), value: schedule.timezone },
            ]}
          />
        </div>
        {canWrite ? (
          <ActionMenu
            label={t("schedule.actions")}
            testId="schedule-menu"
            items={[
              {
                label: t("schedule.edit"),
                onSelect: () => setEditing(true),
                testId: "schedule-edit",
              },
              {
                label: t(schedule.paused ? "schedule.resume" : "schedule.pause"),
                onSelect: () => pause.mutate(!schedule.paused),
                disabled: pause.isPending,
                testId: "schedule-pause",
              },
              {
                label: t("schedule.delete"),
                onSelect: () => setDeleting(true),
                destructive: true,
                testId: "schedule-delete",
              },
            ]}
          />
        ) : null}
      </div>
      {dialog}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        object={t("schedule.object")}
        verb={t("schedule.deleteVerb")}
        consequence={t("schedule.deleteConsequence", { name: workflowName })}
        destructive
        pending={remove.isPending}
        onConfirm={async () => {
          await remove.mutateAsync().catch(() => undefined);
        }}
        testId="schedule-delete-confirm"
      />
    </div>
  );
}
