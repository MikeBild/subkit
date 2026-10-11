import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
import { InputFieldControl } from "@/components/cockpit/run-workflow-dialog";
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
import {
  buildFormInput,
  formFields,
  type InputSchemaSource,
  initialInputValues,
  inputForm,
  invalidInputs,
  missingRequired,
} from "@/lib/workflow-inputs";

type ScheduleEntry = components["schemas"]["ScheduleEntry"];
type ScheduleList = components["schemas"]["ScheduleListResponse"];

interface InputSchemaResponse {
  source: InputSchemaSource;
  schema: Record<string, unknown> | null;
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function valuesFromScheduleInput(
  fields: ReturnType<typeof formFields>,
  input: unknown,
): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = record[field.name];
      if (value === undefined || value === null) return [];
      return [[field.name, typeof value === "string" ? value : JSON.stringify(value)]];
    }),
  );
}

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
  const [values, setValues] = useState<Record<string, string>>(() => ({}));
  const zone = schedule?.timezone ?? localZone();
  const schema = useQuery({
    queryKey: ["workflow", workflowId, "input-schema"],
    enabled: open,
    queryFn: () =>
      apiRequest<InputSchemaResponse>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/input-schema`,
      ),
  });
  const form = inputForm(schema.data?.schema ?? null);
  const fields = formFields(form);
  const filled = {
    ...initialInputValues(fields),
    ...values,
  };
  const missing = missingRequired(fields, filled);
  const invalid = invalidInputs(fields, filled);
  useEffect(() => {
    if (!open) return;
    setValues(valuesFromScheduleInput(fields, schedule?.input));
  }, [open, schedule?.id, schedule?.input, schema.data]);
  const save = useMutation({
    mutationFn: ({ cron, input }: { cron: string; input: unknown }) =>
      schedule
        ? apiRequest(`/v1/schedules/${encodeURIComponent(schedule.id)}`, {
            method: "PUT",
            body: JSON.stringify({
              cron,
              timezone: zone,
              ...(input === undefined ? {} : { input }),
            }),
          })
        : apiRequest("/v1/schedules", {
            method: "POST",
            body: JSON.stringify({
              workflow_id: workflowId,
              cron,
              timezone: zone,
              execution_mode: "prod",
              ...(input === undefined ? {} : { input }),
            }),
          }),
    onSuccess: async () => {
      toast.success(t(schedule ? "schedule.saved" : "schedule.created"));
      onOpenChange(false);
      setValues({});
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
        if (missing.length > 0 || invalid.length > 0) return setError(t("schedule.inputInvalid"));
        setError(null);
        save.mutate({ cron: rhythmToCron(value), input: buildFormInput(form, filled) });
      }}
      error={error}
      testId="schedule-dialog"
    >
      <FactList
        items={[{ label: t("schedule.zone"), value: zone, help: t("schedule.zoneHelp") }]}
      />
      <ScheduleFields value={value} onChange={setValue} invalid={Boolean(error)} />
      {fields.length > 0 ? (
        <div className="grid gap-3" data-testid="schedule-inputs">
          {fields.map((field, index) => (
            <InputFieldControl
              key={field.name}
              field={field}
              index={index}
              idPrefix="schedule-input"
              value={filled[field.name] ?? ""}
              invalid={invalid.includes(field.name)}
              onChange={(next) => setValues((current) => ({ ...current, [field.name]: next }))}
            />
          ))}
        </div>
      ) : null}
      {missing.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="schedule-input-missing">
          {t("schedule.inputMissing", { fields: missing.join(", ") })}
        </p>
      ) : null}
      {invalid.length > 0 ? (
        <p className="text-destructive text-xs" data-testid="schedule-input-invalid">
          {t("schedule.inputInvalid")}
        </p>
      ) : null}
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
