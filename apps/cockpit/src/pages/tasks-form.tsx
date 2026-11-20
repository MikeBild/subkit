import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import {
  CheckListField,
  ChoiceField,
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/cockpit/form-field";
import {
  CollapsibleSection,
  FormDialog,
  Input,
  Label,
  TimezoneSelect,
} from "@/components/cockpit/patterns";
import { cronWords } from "@/lib/cron-words";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { browserTimeZone } from "@/lib/timezones";
import {
  bothEnvironments,
  changesWork,
  DEADLINE_CHOICES,
  draftFromTask,
  draftName,
  EFFORT_CHOICES,
  emptyDraft,
  nextStart,
  SCHEDULE_OPTIONS,
  type ScheduleDraft,
  type ScheduleOption,
  saveErrorKey,
  saveWarning,
  scheduleFields,
  type Task,
  type TaskDraft,
  taskBody,
  withCurrent,
} from "@/pages/tasks-model";
import { createTask, refreshTask, updateTask } from "@/pages/tasks-queries";

type Translate = ReturnType<typeof useI18n>["t"];
type TranslatePlural = ReturnType<typeof useI18n>["tn"];

export function durationWords(minutes: number, tn: TranslatePlural): string {
  if (minutes % 1440 === 0) return tn("tasks.duration.days", minutes / 1440);
  if (minutes % 60 === 0) return tn("tasks.duration.hours", minutes / 60);
  return tn("tasks.duration.minutes", minutes);
}

function schedulePreview(
  value: ScheduleDraft,
  now: number,
  words: { t: Translate; dateTime(value: Date): string; localeTag: string },
): string | null {
  if (value.option === "manual") return words.t("tasks.schedule.preview.manual");
  const built = scheduleFields(value, now);
  if (!built.ok) return null;
  const next = nextStart(built.fields, now);
  if (next) return words.t("tasks.schedule.preview.next", { date: words.dateTime(next) });
  return built.fields.schedule_cron
    ? words.t("tasks.schedule.preview.custom", {
        words: cronWords(built.fields.schedule_cron, words.t, words.localeTag),
      })
    : null;
}

export function TaskScheduleFields({
  value,
  onChange,
}: {
  value: ScheduleDraft;
  onChange(value: ScheduleDraft): void;
}) {
  const { t, locale, dateTime } = useI18n();
  const [now] = useState(() => Date.now());
  const days = useMemo(() => {
    const format = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
      weekday: "long",
      timeZone: "UTC",
    });
    return [1, 2, 3, 4, 5, 6, 0].map((day) => ({
      value: String(day),
      label: format.format(new Date(Date.UTC(2023, 0, 1 + day))),
    }));
  }, [locale]);
  const preview = schedulePreview(value, now, { t, dateTime, localeTag: LOCALE_TAGS[locale] });
  const timed =
    value.option === "daily" || value.option === "weekdays" || value.option === "weekly";
  return (
    <>
      <ChoiceField<ScheduleOption>
        label={t("tasks.schedule.label")}
        value={value.option}
        onChange={(option) => onChange({ ...value, option })}
        options={SCHEDULE_OPTIONS.map((option) => ({
          value: option,
          label: t(`tasks.schedule.option.${option}`),
        }))}
        wrap
        testId="task-schedule-option"
      />
      {value.option === "once" ? (
        <div className="flex min-w-0 flex-col gap-1.5" data-slot="form-field">
          <Label htmlFor="task-schedule-run-at">{t("tasks.schedule.runAt")}</Label>
          <Input
            id="task-schedule-run-at"
            type="datetime-local"
            name="task-schedule-run-at"
            autoComplete="off"
            value={value.runAt}
            onChange={(event) => onChange({ ...value, runAt: event.target.value })}
            data-testid="task-schedule-run-at"
          />
        </div>
      ) : null}
      {value.option === "weekly" ? (
        <SelectField
          id="task-schedule-weekday"
          label={t("schedule.weekday")}
          value={String(value.weekday)}
          onChange={(day) => onChange({ ...value, weekday: Number(day) })}
          options={days}
        />
      ) : null}
      {timed ? (
        <TextField
          id="task-schedule-time"
          type="time"
          label={t("schedule.time")}
          value={value.time}
          onChange={(time) => onChange({ ...value, time })}
        />
      ) : null}
      {value.option === "custom" ? (
        <TextField
          id="task-schedule-cron"
          label={t("tasks.schedule.cron")}
          help={t("tasks.schedule.cronHelp")}
          value={value.cron}
          onChange={(cron) => onChange({ ...value, cron })}
          placeholder="0 7 * * 1"
          mono
        />
      ) : null}
      {value.option === "manual" ? null : (
        <div className="flex min-w-0 flex-col gap-1.5" data-slot="form-field">
          <Label htmlFor="task-schedule-zone">{t("schedule.zone")}</Label>
          <TimezoneSelect
            id="task-schedule-zone"
            label={t("schedule.zone")}
            value={value.timezone}
            onChange={(timezone) => onChange({ ...value, timezone })}
            testId="task-schedule-zone"
          />
        </div>
      )}
      {preview ? (
        <p
          className="text-muted-foreground text-sm"
          aria-live="polite"
          data-testid="task-schedule-preview"
        >
          {preview}
        </p>
      ) : null}
    </>
  );
}

function useBindable(permissions: readonly string[], enabled: boolean) {
  const workflows = useQuery({
    queryKey: ["workflows", "lookup"],
    enabled: enabled && permissions.includes("workflow:read"),
    staleTime: 300_000,
    queryFn: () => apiCall("get", "/v1/workflows", { query: { limit: 200 } }),
  });
  const connectors = useQuery({
    queryKey: ["connectors", "lookup"],
    enabled: enabled && permissions.includes("connector:read"),
    staleTime: 300_000,
    queryFn: () => apiCall("get", "/v1/connectors", { query: { limit: 200 } }),
  });
  return { workflows: workflows.data?.items ?? [], connectors: connectors.data?.items ?? [] };
}

export function TaskFormFields({
  draft,
  onChange,
  workflowOptions,
  connectorOptions,
  choosesEnvironment,
}: {
  draft: TaskDraft;
  onChange(change: Partial<TaskDraft>): void;
  workflowOptions: readonly { value: string; label: string }[];
  connectorOptions: readonly { value: string; label: string }[];
  choosesEnvironment: boolean;
}) {
  const { t, tn } = useI18n();
  return (
    <>
      <TextAreaField
        id="task-form-goal"
        label={t("tasks.form.goal")}
        value={draft.goal}
        onChange={(goal) => onChange({ goal })}
        placeholder={t("tasks.form.goalPlaceholder")}
        rows={3}
      />
      <TextAreaField
        id="task-form-done-when"
        label={t("tasks.form.doneWhen")}
        value={draft.doneWhen}
        onChange={(doneWhen) => onChange({ doneWhen })}
        placeholder={t("tasks.form.doneWhenPlaceholder")}
        rows={2}
      />
      <fieldset
        className="flex min-w-0 flex-col gap-3"
        data-slot="form-field"
        data-testid="task-form-use"
      >
        <legend id="task-form-use-label" className="mb-3 text-sm font-medium">
          {t("tasks.form.use")}
        </legend>
        <CheckListField
          id="task-form-workflows"
          label={t("tasks.form.workflows")}
          values={draft.workflowIds}
          onChange={(workflowIds) => onChange({ workflowIds })}
          options={workflowOptions}
          empty={t("tasks.form.workflowsEmpty")}
          quiet
        />
        <CheckListField
          id="task-form-connectors"
          label={t("tasks.form.connectors")}
          values={draft.connectorIds}
          onChange={(connectorIds) => onChange({ connectorIds })}
          options={connectorOptions}
          empty={t("tasks.form.connectorsEmpty")}
          quiet
        />
      </fieldset>
      <CollapsibleSection label={t("tasks.form.more")} testId="task-form-more">
        <div className="flex min-w-0 flex-col gap-4">
          <TextField
            id="task-form-name"
            label={t("tasks.form.name")}
            help={t("tasks.form.nameHelp")}
            value={draft.nameEdited ? draft.name : draftName(draft)}
            onChange={(name) => onChange({ name, nameEdited: name.trim() !== "" })}
          />
          <TaskScheduleFields
            value={draft.schedule}
            onChange={(schedule) => onChange({ schedule })}
          />
          <ChoiceField<"on" | "off">
            label={t("tasks.form.webSearch")}
            value={draft.webSearch ? "on" : "off"}
            onChange={(value) => onChange({ webSearch: value === "on" })}
            options={[
              { value: "off", label: t("tasks.form.webSearch.off") },
              { value: "on", label: t("tasks.form.webSearch.on") },
            ]}
            testId="task-form-web-search"
          />
          {choosesEnvironment ? (
            <ChoiceField<Task["environment"]>
              label={t("tasks.form.environment")}
              description={t("tasks.form.environmentHelp")}
              value={draft.environment}
              onChange={(environment) => onChange({ environment })}
              options={[
                { value: "dev", label: t("tasks.environment.dev") },
                { value: "prod", label: t("tasks.environment.prod") },
              ]}
              testId="task-form-environment"
            />
          ) : null}
          <SelectField
            id="task-form-deadline"
            label={t("tasks.form.deadline")}
            value={String(draft.deadlineMinutes)}
            onChange={(value) => onChange({ deadlineMinutes: Number(value) })}
            options={withCurrent(DEADLINE_CHOICES, draft.deadlineMinutes).map((minutes) => ({
              value: String(minutes),
              label: durationWords(minutes, tn),
            }))}
          />
          <SelectField
            id="task-form-effort"
            label={t("tasks.form.effort")}
            value={String(draft.maxTurns)}
            onChange={(value) => onChange({ maxTurns: Number(value) })}
            options={withCurrent(EFFORT_CHOICES, draft.maxTurns).map((count) => ({
              value: String(count),
              label: String(count),
            }))}
          />
        </div>
      </CollapsibleSection>
    </>
  );
}

export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  seed,
  permissions,
  openRun = false,
  grantLive = false,
  onSaved,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  task?: Task;
  seed?: Partial<TaskDraft>;
  permissions: readonly string[];
  openRun?: boolean;
  grantLive?: boolean;
  onSaved?(task: Task): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [zone] = useState(browserTimeZone);
  const [draft, setDraft] = useState<TaskDraft>(() =>
    task ? draftFromTask(task, zone) : emptyDraft(zone, seed),
  );
  const [revision] = useState(task?.revision ?? 0);
  const [error, setError] = useState<string | null>(null);
  const bindable = useBindable(permissions, open);
  const set = (change: Partial<TaskDraft>) => setDraft((current) => ({ ...current, ...change }));

  const workflowOptions = bindable.workflows
    .filter((item) => item.lifecycle !== "archived" || draft.workflowIds.includes(item.id))
    .map((item) => ({ value: item.id, label: item.name }));
  const connectorOptions = bindable.connectors
    .filter(
      (item) => item.environment === draft.environment || draft.connectorIds.includes(item.id),
    )
    .map((item) => ({ value: item.id, label: item.display_name }));
  const choosesEnvironment = bothEnvironments(bindable.connectors, task?.environment ?? null);

  const built = taskBody(draft, task ?? null, Date.now());
  const warning =
    task && built.ok ? saveWarning(changesWork(task, built.body), openRun, grantLive) : null;

  const save = useMutation({
    mutationFn: async (body: Parameters<typeof createTask>[0]): Promise<Task> =>
      task ? await updateTask(task.id, body, revision) : await createTask(body),
    onSuccess: async (saved) => {
      toast.success(t(task ? "tasks.form.saved" : "tasks.form.created", { name: saved.name }));
      await refreshTask(client, saved.id);
      onOpenChange(false);
      onSaved?.(saved);
    },
    onError: (failure) =>
      setError(t(saveErrorKey(failure instanceof ApiError ? failure.code : null))),
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(task ? "tasks.form.editTitle" : "tasks.form.createTitle")}
      submit={{
        label: t(task ? "common.save" : "tasks.form.create"),
        pending: save.isPending,
      }}
      onSubmit={() => {
        if (!built.ok) return setError(t(built.issue));
        setError(null);
        save.mutate(built.body);
      }}
      error={error}
      hint={warning ? t(warning) : undefined}
      size="wide"
      testId="task-form"
    >
      <TaskFormFields
        draft={draft}
        onChange={set}
        workflowOptions={workflowOptions}
        connectorOptions={connectorOptions}
        choosesEnvironment={choosesEnvironment}
      />
    </FormDialog>
  );
}
