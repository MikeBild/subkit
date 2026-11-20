import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Check, Circle, CircleDot, CircleHelp } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import { absolute, conversationHref, settingsHref, usageHref } from "@/app/links";
import { CatalogCategoryChip } from "@/components/cockpit/catalog-metadata";
import { GrantTaskAuthority } from "@/components/cockpit/grant-task-authority";
import {
  ActionButton,
  ActionMenu,
  type ActionMenuItem,
  type ActionSpec,
  BackLink,
  ConfirmDialog,
  ContextHelp,
  DataState,
  DetailPage,
  FactList,
  KpiTile,
  type PageTab,
  Skeleton,
  TabBody,
  Timeline,
} from "@/components/cockpit/patterns";
import { MISSING } from "@/components/cockpit/table-columns";
import { TaskPermissions } from "@/components/cockpit/task-permissions";
import { ForbiddenState, LoadFailed, queryView } from "@/components/failure-state";
import { cronWords } from "@/lib/cron-words";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useSearchParamState } from "@/lib/use-search-param-state";
import { cn } from "@/lib/utils";
import { runNowStep } from "@/pages/chat-task-run";
import { TaskFormDialog } from "@/pages/tasks-form";
import { historyTitle } from "@/pages/tasks-history";
import {
  actionKey,
  hasSchedule,
  historyTone,
  isOpenRun,
  quotedQuestion,
  rhythm,
  type StartView,
  startErrorKey,
  startView,
  stateWords,
  TASKS_PATH,
  type Task,
  type TaskLatestRun,
  type TaskRun,
  type TaskStatus,
  type TaskView,
  taskStatus,
  type UsageFigure,
  usageExcludesWorkflowCalls,
  usageFigure,
} from "@/pages/tasks-model";
import {
  abortTaskRun,
  deleteTask,
  pauseTask,
  refreshTask,
  resumeTask,
  startTaskRun,
  taskKeys,
  useRunPlaybook,
  useTask,
  useTaskHistory,
  useTaskRun,
  useTaskRuns,
  useTaskUsage,
} from "@/pages/tasks-queries";
import { TaskReviewDialog, TaskRunSheet, TaskRunsTab } from "@/pages/tasks-runs";
import { type StepMark, stepLines, stepMarkKey, stepResults } from "@/pages/tasks-steps";
import { StopRunDialog } from "@/pages/tasks-stop-dialog";
import { waitingForKey } from "@/pages/tasks-waiting";
import { type UsageFormat, useUsageFormat } from "@/pages/usage-format";

type Translate = ReturnType<typeof useI18n>["t"];
type Playbook = NonNullable<ReturnType<typeof useRunPlaybook>["data"]>;

const STEP_ICONS: Record<StepMark, typeof Check> = {
  done: Check,
  active: CircleDot,
  waiting: CircleHelp,
  open: Circle,
};

const STEP_TONES: Record<StepMark, string> = {
  done: "text-emerald-700 dark:text-emerald-400",
  active: "text-foreground",
  waiting: "text-amber-700 dark:text-amber-400",
  open: "text-muted-foreground",
};

function StepProgress({
  task,
  playbook,
  state,
}: {
  task: Task;
  playbook: Playbook | null;
  state: string | null;
}) {
  const { t } = useI18n();
  const lines = stepLines(task.plan, playbook?.steps ?? null, state);
  return (
    <ol className="flex min-w-0 flex-col gap-2" data-testid="task-steps">
      {lines.map((line) => {
        const Icon = STEP_ICONS[line.mark];
        return (
          <li
            key={line.id}
            className="flex min-w-0 items-start gap-2 text-sm"
            data-step-mark={line.mark}
          >
            <Icon
              aria-hidden="true"
              className={cn("mt-0.5 size-4 shrink-0", STEP_TONES[line.mark])}
            />
            <span
              className={cn(
                "min-w-0 [overflow-wrap:anywhere]",
                line.mark === "active" && "font-medium",
              )}
            >
              {line.label ?? t("tasks.step.confirm")}
            </span>
            {line.mark === "open" ? null : (
              <span className="sr-only">{t(stepMarkKey(line.mark))}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function rhythmWords(task: Task, t: Translate, localeTag: string, date: (at: string) => string) {
  const value = rhythm(task);
  if (value.kind === "cron") return cronWords(value.cron, t, localeTag);
  if (value.kind === "once") return t("tasks.next.once", { date: date(value.at) });
  return t(value.kind === "done" ? "tasks.next.done" : "tasks.next.manual");
}

function usageWords(
  figure: UsageFigure,
  t: Translate,
  format: Pick<UsageFormat, "money" | "count">,
): string {
  if (figure.kind === "removed") return t("tasks.usage.removed");
  if (figure.kind === "none") return t("tasks.usage.none");
  if (figure.kind === "tokens")
    return `${format.count(figure.tokens)} ${t("resource.field.tokens")}`;
  const money = format.money(figure.amount);
  return figure.atLeast ? t("tasks.usage.atLeast", { value: money }) : money;
}

function UsageTile({ taskId }: { taskId: string }) {
  const { t } = useI18n();
  const query = useTaskUsage(taskId, true);
  const usage = query.data ?? null;
  const currency = usage?.last_run.cost?.currency ?? usage?.current_month.cost?.currency ?? "USD";
  const format = useUsageFormat(currency);
  return (
    <KpiTile
      dense
      label={
        <span className="inline-flex items-center gap-1">
          {t("tasks.usage.label")}
          {usage && usageExcludesWorkflowCalls(usage) ? (
            <ContextHelp label={t("tasks.usage.label")} testId="task-usage-help">
              {t("tasks.usage.help")}
            </ContextHelp>
          ) : null}
        </span>
      }
      note={
        usage
          ? t("tasks.usage.lastRun", { value: usageWords(usageFigure(usage.last_run), t, format) })
          : MISSING
      }
      detail={
        usage
          ? t("tasks.usage.month", {
              value: usageWords(usageFigure(usage.current_month), t, format),
            })
          : undefined
      }
      testId="task-tile-usage"
      detailTestId="task-tile-usage-month"
    />
  );
}

function OverviewTab({
  task,
  run,
  sleepReason,
  playbook,
  start,
}: {
  task: Task;
  run: TaskLatestRun | null;
  sleepReason: string | null;
  playbook: Playbook | null;
  start: StartView;
}) {
  const { t, dateTime } = useI18n();
  const live = run && (isOpenRun(run) || run.state === "result_ready") ? run : null;
  const now = live
    ? (runNowStep(playbook, live.state, t, live.waiting_reason) ??
      stateWords(live.state, live, { t, time: dateTime }))
    : t("tasks.overview.now.idle");
  const waitsFor = waitingForKey(live);
  const waitingFor = waitsFor
    ? t(waitsFor)
    : live?.state === "sleeping" && sleepReason
      ? sleepReason
      : t("tasks.overview.waiting.nobody");
  const nextCheck =
    live?.state === "sleeping" && live.next_check_at
      ? dateTime(live.next_check_at)
      : start.kind === "at"
        ? dateTime(start.at)
        : t(start.kind === "due" ? start.line : "tasks.overview.next.none");
  return (
    <TabBody
      testId="task-overview"
      summary={task.goal}
      technical={
        <FactList
          testId="task-technical-facts"
          items={[
            {
              label: t("tasks.technical.id"),
              value: <span className="break-all font-mono text-xs">{task.id}</span>,
            },
            { label: t("tasks.technical.environment"), value: task.environment },
            { label: t("tasks.technical.revision"), value: String(task.revision) },
            {
              label: t("tasks.technical.fingerprint"),
              value: <span className="break-all font-mono text-xs">{task.fingerprint}</span>,
            },
            {
              label: t("tasks.technical.cron"),
              value: task.schedule_cron ? (
                <span className="font-mono text-xs">{task.schedule_cron}</span>
              ) : (
                MISSING
              ),
            },
            {
              label: t("tasks.technical.limits"),
              value: t("tasks.technical.limitsValue", {
                turns: task.max_turns,
                minutes: task.run_deadline_minutes,
              }),
            },
          ]}
        />
      }
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="task-tiles">
        <KpiTile dense label={t("tasks.overview.now")} note={now} testId="task-tile-now" />
        <KpiTile
          dense
          label={t("tasks.overview.waitingFor")}
          note={waitingFor}
          testId="task-tile-waiting"
        />
        <KpiTile
          dense
          label={t("tasks.overview.nextCheck")}
          note={nextCheck}
          testId="task-tile-next"
        />
        <UsageTile taskId={task.id} />
      </div>
      <FactList
        testId="task-overview-facts"
        items={[
          {
            label: t("tasks.overview.doneWhen"),
            value: <span className="[overflow-wrap:anywhere]">{task.done_when}</span>,
            testId: "task-done-when",
          },
          {
            label: t("tasks.overview.steps"),
            value: <StepProgress task={task} playbook={playbook} state={run?.state ?? null} />,
          },
        ]}
      />
    </TabBody>
  );
}

function ScheduleTab({ task, start }: { task: Task; start: StartView }) {
  const { t, locale, dateTime } = useI18n();
  const value = rhythm(task);
  const words = rhythmWords(task, t, LOCALE_TAGS[locale], dateTime);
  const summary = task.paused_at
    ? t("tasks.schedule.summary.paused")
    : value.kind === "cron"
      ? t("tasks.schedule.summary.cron", { words })
      : value.kind === "once"
        ? t("tasks.schedule.summary.once", { date: dateTime(value.at) })
        : t(
            value.kind === "done" ? "tasks.schedule.summary.done" : "tasks.schedule.summary.manual",
          );
  const next =
    start.kind === "at" ? dateTime(start.at) : start.kind === "due" ? t(start.line) : MISSING;
  return (
    <TabBody testId="task-schedule" summary={summary}>
      <FactList
        testId="task-schedule-facts"
        items={[
          {
            label: t("tasks.schedule.fact.rhythm"),
            value: words,
            testId: "task-schedule-rhythm",
          },
          { label: t("tasks.schedule.fact.next"), value: next, testId: "task-schedule-next" },
          ...(task.schedule_timezone
            ? [{ label: t("schedule.zone"), value: task.schedule_timezone.replace(/_/g, " ") }]
            : []),
        ]}
      />
    </TabBody>
  );
}

function HistoryTab({ taskId }: { taskId: string }) {
  const { t, tn, dateTime } = useI18n();
  const query = useTaskHistory(taskId, true);
  const view = queryView(query, (data) => data.items.length === 0);
  if (view === "loading") return <DataState state="loading" testId="task-history-loading" />;
  if (view === "error")
    return (
      <DataState
        state="error"
        line={t("tasks.history.loadFailed")}
        onRetry={() => void query.refetch()}
        testId="task-history-failed"
      />
    );
  const entries = query.data?.items ?? [];
  if (view === "empty")
    return <DataState state="empty" line={t("tasks.history.none")} testId="task-history-empty" />;
  return (
    <TabBody testId="task-history" summary={tn("tasks.history.summary", entries.length)}>
      <Timeline
        testId="task-history-timeline"
        groups={[
          {
            items: entries.map((entry) => ({
              id: entry.id,
              tone: historyTone(entry.action, entry.result),
              title: historyTitle(entry, t),
              time: dateTime(entry.ts),
              dateTime: entry.ts,
            })),
          },
        ]}
      />
    </TabBody>
  );
}

function stripAction(
  status: TaskStatus,
  run: Pick<TaskLatestRun, "conversation_id"> | null,
  permissions: readonly string[],
  t: Translate,
  act: {
    review(): void;
    allow(): void;
    resume(): void;
    view(): void;
    resuming: boolean;
  },
): ActionSpec | undefined {
  if (!status.action) return undefined;
  const label = t(actionKey(status.action));
  const testId = `task-strip-${status.action}`;
  if (status.action === "usage")
    return permissions.includes("stats:read")
      ? { label, variant: "primary", href: absolute(usageHref()), testId }
      : undefined;
  if (status.action === "ai_access")
    return {
      label,
      variant: "primary",
      href: absolute(settingsHref(null, { area: "ai" })),
      testId,
    };
  if (status.action === "answer" || status.action === "continue")
    return run?.conversation_id && permissions.includes("conversation:read")
      ? {
          label,
          variant: "primary",
          href: absolute(conversationHref(run.conversation_id)),
          testId,
        }
      : undefined;
  if (status.action === "review")
    return permissions.includes("task:run")
      ? { label, variant: "primary", onClick: act.review, testId }
      : undefined;
  if (status.action === "allow")
    return permissions.includes("task:grant")
      ? { label, variant: "primary", onClick: act.allow, testId }
      : undefined;
  if (status.action === "resume")
    return permissions.includes("task:resume")
      ? { label, variant: "primary", onClick: act.resume, pending: act.resuming, testId }
      : undefined;
  return run ? { label, onClick: act.view, testId } : undefined;
}

export function TaskDetail({
  task,
  permissions,
}: {
  task: TaskView;
  permissions: readonly string[];
}) {
  const { t, locale, dateTime } = useI18n();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [now] = useState(() => Date.now());
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<"delete" | "stop" | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [granting, setGranting] = useState(false);
  const [shownRun, setShownRun] = useSearchParamState("task_run", "");
  const canSeeRuns = permissions.includes("task_run:read");
  const scheduled = hasSchedule(task);
  const runs = useTaskRuns(task.id, canSeeRuns);
  const items = (runs.data?.items ?? []).filter((run): run is TaskRun => run !== null);
  const latest = task.latest_run;
  const latestRecord = items.find((run) => run.id === latest?.id) ?? null;
  const openRun = isOpenRun(latest);
  const grantLive = scheduled ? task.grant_live : null;
  const asked = useTaskRun(latest?.id ?? null, canSeeRuns && latest?.state === "waiting");
  const question =
    latest?.state === "waiting" && waitingForKey(latest) === "tasks.overview.waiting.you"
      ? quotedQuestion(asked.data?.pending_question)
      : null;
  const playbook = useRunPlaybook(
    latest?.conversation_id ?? null,
    permissions.includes("conversation:read"),
  );
  const status = taskStatus({ task, run: latest, grantLive });
  const nextUp = startView(task, now);
  const refresh = () => refreshTask(client, task.id);
  const failed = () => toast.error(t("common.actionFailed"));

  const start = useMutation({
    mutationFn: () => startTaskRun(task.id),
    onSuccess: async () => {
      toast.success(t("tasks.started", { name: task.name }));
      await refresh();
    },
    onError: (failure) =>
      toast.error(t(startErrorKey(failure instanceof ApiError ? failure.code : null))),
  });
  const pause = useMutation({
    mutationFn: () => pauseTask(task.id),
    onSuccess: async () => {
      toast.success(t("tasks.paused", { name: task.name }));
      await refresh();
    },
    onError: failed,
  });
  const resume = useMutation({
    mutationFn: () => resumeTask(task.id),
    onSuccess: async () => {
      toast.success(t("tasks.resumed", { name: task.name }));
      await refresh();
    },
    onError: failed,
  });
  const stop = useMutation({
    mutationFn: (runId: string) => abortTaskRun(runId),
    onSuccess: async () => {
      toast.success(t("tasks.stopped"));
      setConfirming(null);
      await refresh();
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: () => deleteTask(task.id),
    onSuccess: async () => {
      toast.success(t("tasks.deleted", { name: task.name }));
      setConfirming(null);
      await client.invalidateQueries({ queryKey: taskKeys.lists });
      void navigate({ to: TASKS_PATH });
    },
    onError: failed,
  });

  const startBlocked = !permissions.includes("task:run")
    ? t("tasks.start.unavailable.permission")
    : task.paused_at
      ? t("tasks.start.unavailable.paused")
      : openRun
        ? t("tasks.start.unavailable.active")
        : undefined;

  const menu: ActionMenuItem[] = [
    ...(permissions.includes("task:write")
      ? [
          {
            label: t("tasks.menu.edit"),
            onSelect: () => setEditing(true),
            testId: "task-menu-edit",
          },
        ]
      : []),
    ...(permissions.includes("task:pause") && !task.paused_at
      ? [
          {
            label: t("tasks.menu.pause"),
            onSelect: () => pause.mutate(),
            disabled: pause.isPending,
            testId: "task-menu-pause",
          },
        ]
      : []),
    ...(permissions.includes("task_run:abort") && openRun
      ? [
          {
            label: t("tasks.menu.stop"),
            onSelect: () => setConfirming("stop"),
            testId: "task-menu-stop",
          },
        ]
      : []),
    ...(permissions.includes("task:delete")
      ? [
          {
            label: t("tasks.menu.delete"),
            onSelect: () => setConfirming("delete"),
            destructive: true,
            testId: "task-menu-delete",
          },
        ]
      : []),
  ];

  const tabs: PageTab[] = [
    {
      value: "overview",
      label: t("tasks.tab.overview"),
      content: (
        <OverviewTab
          task={task}
          run={latest}
          sleepReason={latestRecord?.sleep_reason ?? null}
          playbook={playbook.data ?? null}
          start={nextUp}
        />
      ),
    },
    ...(canSeeRuns
      ? [
          {
            value: "runs",
            label: t("tasks.tab.runs"),
            content: (
              <TaskRunsTab
                runs={items}
                total={runs.data?.total}
                pending={runs.isPending && !runs.failureReason}
                failed={Boolean(runs.error || runs.failureReason)}
                onRetry={() => void runs.refetch()}
                onOpen={(run) => setShownRun(run.id)}
              />
            ),
          },
        ]
      : []),
    {
      value: "schedule",
      label: t("tasks.tab.schedule"),
      content: <ScheduleTab task={task} start={nextUp} />,
    },
    {
      value: "permissions",
      label: t("tasks.tab.permissions"),
      content: (
        <TaskPermissions
          taskId={task.id}
          allowOffered={status.action === "allow" && permissions.includes("task:grant")}
        />
      ),
    },
    ...(permissions.includes("audit:read")
      ? [
          {
            value: "history",
            label: t("tasks.tab.history"),
            content: <HistoryTab taskId={task.id} />,
          },
        ]
      : []),
  ];

  const more =
    status.kind === "sleeping" && latest?.next_check_at
      ? dateTime(latest.next_check_at)
      : status.kind === "scheduled"
        ? rhythmWords(task, t, LOCALE_TAGS[locale], dateTime)
        : undefined;

  return (
    <DetailPage
      testId="detail-tasks"
      back={{ to: TASKS_PATH, label: t("nav.tasks") }}
      title={task.name}
      badge={<CatalogCategoryChip category={task.category} testId="task-category-chip" />}
      action={
        <ActionButton
          variant="primary"
          onClick={() => start.mutate()}
          pending={start.isPending}
          disabled={Boolean(startBlocked)}
          disabledReason={startBlocked}
          testId="task-start"
        >
          {t("tasks.start")}
        </ActionButton>
      }
      menu={menu.length > 0 ? <ActionMenu items={menu} alwaysMenu testId="task-menu" /> : undefined}
      strip={{
        tone: status.tone,
        line:
          status.kind === "waiting" && question
            ? t("tasks.strip.waiting.quoted", { question })
            : t(status.line),
        more,
        action: stripAction(status, latest, permissions, t, {
          review: () => setReviewing(true),
          allow: () => setGranting(true),
          resume: () => resume.mutate(),
          view: () => setShownRun(latest ? latest.id : ""),
          resuming: resume.isPending,
        }),
      }}
      tabs={tabs}
    >
      {permissions.includes("task:write") && editing ? (
        <TaskFormDialog
          open
          onOpenChange={setEditing}
          task={task}
          permissions={permissions}
          openRun={openRun}
          grantLive={grantLive === true}
        />
      ) : null}
      {latest && reviewing ? (
        <TaskReviewDialog
          task={task}
          run={latest}
          results={stepResults(playbook.data?.steps)}
          open
          onOpenChange={setReviewing}
          canOpen={permissions.includes("conversation:read")}
        />
      ) : null}
      {granting && permissions.includes("task:grant") ? (
        <GrantTaskAuthority taskId={task.id} open onOpenChange={setGranting} />
      ) : null}
      <TaskRunSheet
        task={task}
        run={items.find((run) => run.id === shownRun) ?? null}
        onClose={() => setShownRun("")}
        permissions={permissions}
      />
      <StopRunDialog
        name={task.name}
        open={confirming === "stop"}
        onOpenChange={(next) => !next && setConfirming(null)}
        pending={stop.isPending}
        onConfirm={async () => {
          if (latest) await stop.mutateAsync(latest.id).catch(() => undefined);
        }}
        testId="task-stop-confirm"
      />
      <ConfirmDialog
        open={confirming === "delete"}
        onOpenChange={(next) => !next && setConfirming(null)}
        object={task.name}
        verb={t("tasks.delete.verb")}
        consequence={t("tasks.delete.consequence")}
        destructive
        pending={remove.isPending}
        onConfirm={async () => {
          await remove.mutateAsync().catch(() => undefined);
        }}
        testId="task-delete-confirm"
      />
    </DetailPage>
  );
}

export function TaskPage({ permissions }: { permissions: readonly string[] }) {
  const { t } = useI18n();
  const { resourceId: id = "" } = useParams({ strict: false }) as { resourceId?: string };
  const canRead = permissions.includes("task:read");
  const query = useTask(id, canRead);
  if (!canRead)
    return (
      <div className="p-6" data-testid="detail-tasks">
        <ForbiddenState />
      </div>
    );
  const view = queryView(query, () => false);
  if (view === "loading")
    return (
      <div className="grid gap-4 p-6" data-testid="detail-tasks-loading">
        <Skeleton className="h-12 w-80" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  if (view === "error" || !query.data)
    return (
      <div className="grid gap-4 p-6">
        <BackLink to={TASKS_PATH} label={t("nav.tasks")} />
        <LoadFailed
          title={t("detail.loadFailed")}
          onRetry={() => void query.refetch()}
          testId="detail-load-failed"
        />
      </div>
    );
  return <TaskDetail key={query.data.id} task={query.data} permissions={permissions} />;
}
