import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { absolute, chatNewHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { SelectField, TextField } from "@/components/cockpit/form-field";
import {
  ActionButton,
  ActionFailureHost,
  ActionMenu,
  ConfirmDialog,
  DataState,
  FactList,
  FormDialog,
  SchemaForm,
  SegmentedControl,
} from "@/components/cockpit/patterns";
import { invalidateWorkflowAutomation } from "@/features/grants";
import { cronWords } from "@/features/workflows/model/cron-words";
import {
  cronToRhythm,
  DEFAULT_RHYTHM,
  type Rhythm,
  type RhythmValue,
  rhythmToCron,
  validTime,
} from "@/features/workflows/model/schedule-rhythm";
import { ScheduleCostPreview, ScheduleCostValue } from "@/features/workflows/ui/schedule-cost";
import { reportFailure } from "@/lib/action-failure";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { buildFormSchemaInput, formValuesFromInput, type SchemaValues } from "@/lib/schema-form";
import { formFields, inputForm } from "@/lib/workflow-inputs";

type ScheduleEntry = components["schemas"]["ScheduleEntry"];
type ScheduleInput = components["schemas"]["ScheduleCreateBody"]["input"];

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function useWorkflowSchedule(workflowId: string) {
  const live = useLiveQueryOptions();
  const query = useQuery({
    queryKey: ["workflow", workflowId, "schedules"],
    queryFn: () => apiCall("get", "/v1/schedules", { query: { workflow_id: workflowId } }),
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
  const [values, setValues] = useState<SchemaValues | null>(null);
  const [checked, setChecked] = useState(false);
  const zone = schedule?.timezone ?? localZone();
  const schema = useQuery({
    queryKey: ["workflow", workflowId, "input-schema"],
    enabled: open,
    queryFn: () => apiCall("get", "/v1/workflows/{id}/input-schema", { path: { id: workflowId } }),
  });
  const form = inputForm(schema.data?.schema ?? null);
  const fields = formFields(form);
  const filled = values ?? formValuesFromInput(form, schedule?.input);
  const built = buildFormSchemaInput(form, filled);
  useEffect(() => {
    if (!open) return;
    setValues(null);
    setChecked(false);
  }, [open, schedule?.id]);
  const save = useMutation({
    mutationFn: ({ cron, input }: { cron: string; input: ScheduleInput }) =>
      schedule
        ? apiCall("put", "/v1/schedules/{id}", {
            path: { id: schedule.id },
            body: { cron, timezone: zone, ...(input === undefined ? {} : { input }) },
          })
        : apiCall("post", "/v1/schedules", {
            body: {
              workflow_id: workflowId,
              cron,
              timezone: zone,
              ...(input === undefined ? {} : { input }),
            },
          }),
    onSuccess: async () => {
      toast.success(t(schedule ? "schedule.saved" : "schedule.created"));
      onOpenChange(false);
      setValues(null);
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
        setChecked(true);
        if (built.errors.length > 0) return setError(t("schedule.inputInvalid"));
        setError(null);
        save.mutate({ cron: rhythmToCron(value), input: built.input });
      }}
      error={error}
      failure={error === t("schedule.saveFailed") ? save.error : undefined}
      testId="schedule-dialog"
    >
      <FactList
        items={[{ label: t("schedule.zone"), value: zone, help: t("schedule.zoneHelp") }]}
      />
      <ScheduleFields value={value} onChange={setValue} invalid={Boolean(error)} />
      {validTime(value.time) ? (
        <ScheduleCostPreview
          workflowId={workflowId}
          cron={rhythmToCron(value)}
          timezone={zone}
          enabled={open}
        />
      ) : null}
      <SchemaForm
        fields={fields}
        values={filled}
        onChange={(next) => setValues(next)}
        errors={checked ? built.errors : []}
        testId="schedule-inputs"
      />
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
      apiCall("put", "/v1/schedules/{id}", { path: { id: schedule?.id ?? "" }, body: { paused } }),
    onSuccess: async (_result, paused) => {
      toast.success(t(paused ? "schedule.paused" : "schedule.resumed"));
      await refresh();
    },
    onError: (failure) =>
      reportFailure(t("common.actionFailed"), failure, { scope: "workflow-schedule" }),
  });
  const remove = useMutation({
    mutationFn: () => apiCall("delete", "/v1/schedules/{id}", { path: { id: schedule?.id ?? "" } }),

    onSuccess: async () => {
      toast.success(t("schedule.deleted"));
      setDeleting(false);
      await refresh();
    },
    onError: (failure) => reportFailure(t("common.actionFailed"), failure),
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
                          prompt: t("schedule.chatPrompt"),
                          references: [{ type: "workflow", id: workflowId }],
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
      <ActionFailureHost level="page" scope="workflow-schedule" />
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <FactList
            items={[
              {
                label: t("schedule.rhythm"),
                value: words,
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
              {
                label: t("schedule.cost.label"),
                value: (
                  <ScheduleCostValue
                    projection={schedule.cost_projection}
                    testId="schedule-cost-fact"
                  />
                ),
                help: t("schedule.cost.help"),
              },
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
      {schedule.input_error ? (
        <p className="text-destructive text-sm" data-testid="schedule-input-required">
          {t("schedule.inputRequired", { issue: schedule.input_error.issues[0]?.message ?? "" })}
        </p>
      ) : null}
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
