import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { cn } from "@ui/lib/utils";
import { ProgressRing } from "@ui/molecules/charts";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { StepGraph } from "@ui/organisms/step-graph";
import { CircleHelp, ListChecks, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import {
  absolute,
  conversationHref,
  conversationMessageHref,
  settingsHref,
  usageHref,
} from "@/app/links";
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
  DetailPageLoading,
  FactList,
  IconTile,
  KpiTile,
  type PageTab,
  SectionHeading,
  TabBody,
  Timeline,
} from "@/components/cockpit/patterns";
import { MISSING } from "@/components/cockpit/table-columns";
import { ForbiddenState, LoadFailed, queryView } from "@/components/failure-state";
import { CatalogCategoryChip } from "@/features/catalog";
import {
  ApprovalExpiryNote,
  GrantTaskAuthority,
  TaskPermissions,
  useTaskGrantExpiry,
} from "@/features/grants";
import { WaitingOnApprover } from "@/features/overview";
import { type UsageFormat, useUsageFormat } from "@/features/usage";
import { EnvironmentChip, ScheduleHistory } from "@/features/workflows";
import { cronWords } from "@/features/workflows/model";
import { reportFailure } from "@/lib/action-failure";
import type { Translate } from "@/lib/i18n";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useSearchParamState } from "@/lib/use-search-param-state";
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
} from "../api/tasks-queries";
import { roundBudget } from "../model/progress-model";
import { historyTitle } from "../model/tasks-history";
import {
  actionKey,
  failureReason,
  failureRemedies,
  hasSchedule,
  historyTone,
  isOpenRun,
  quotedQuestion,
  rhythm,
  type StartView,
  startErrorKey,
  startView,
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
} from "../model/tasks-model";
import {
  type StepMark,
  stepGraphState,
  stepLines,
  stepMarkKey,
  stepResults,
} from "../model/tasks-steps";
import { waitingForKey } from "../model/tasks-waiting";
import { StopRunDialog } from "../stop-dialog";
import { TaskFormDialog } from "./tasks-form";
import { TaskReviewSection } from "./tasks-review";
import { TaskReviewDialog, TaskRunSheet, TaskRunsTab } from "./tasks-runs";

type Playbook = NonNullable<ReturnType<typeof useRunPlaybook>["data"]>;

const STEP_ICONS: Partial<Record<StepMark, LucideIcon>> = { waiting: CircleHelp };

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
    <section className="flex flex-col gap-3" aria-labelledby="task-steps-title">
      <div className="flex items-center gap-3">
        <IconTile size="sm">
          <ListChecks aria-hidden="true" />
        </IconTile>
        <SectionHeading id="task-steps-title" className="font-semibold">
          {t("tasks.overview.steps")}
        </SectionHeading>
      </div>
      <div className="rounded-xl border p-4" data-testid="task-steps">
        <StepGraph
          label={t("tasks.overview.steps")}
          steps={lines.map((line) => ({
            label: line.label ?? t("tasks.step.confirm"),
            state: stepGraphState(line.mark),
            ...(STEP_ICONS[line.mark] ? { icon: STEP_ICONS[line.mark] } : {}),
            sub:
              line.mark === "open" ? (
                <span data-step-mark={line.mark} />
              ) : (
                <span className="sr-only" data-step-mark={line.mark}>
                  {t(stepMarkKey(line.mark))}
                </span>
              ),
          }))}
        />
      </div>
    </section>
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
        <span className="inline-flex min-h-7 items-center gap-1">
          {t("tasks.usage.label")}
          {usage && usageExcludesWorkflowCalls(usage) ? (
            <ContextHelp label={t("tasks.usage.label")} testId="task-usage-help">
              {t("tasks.usage.help")}
            </ContextHelp>
          ) : null}
        </span>
      }
      note={
        usage ? (
          usage.last_run_notice ? (
            <span className="text-warning-ink" data-testid="task-usage-run-notice">
              {t("tasks.usage.lastRunOver", {
                value: format.money(usage.last_run_notice.run_cost_usd),
                threshold: format.money(usage.last_run_notice.threshold_usd),
              })}
            </span>
          ) : (
            t("tasks.usage.lastRun", { value: usageWords(usageFigure(usage.last_run), t, format) })
          )
        ) : (
          MISSING
        )
      }
      detail={
        usage
          ? t("tasks.usage.month", {
              value: usageWords(usageFigure(usage.current_month), t, format),
            })
          : query.isPending
            ? "\u00a0"
            : undefined
      }
      testId="task-tile-usage"
      detailTestId="task-tile-usage-month"
    />
  );
}

function TaskTechnicalFacts({ task }: { task: Task }) {
  const { t } = useI18n();
  return (
    <FactList
      testId="task-technical-facts"
      items={[
        {
          label: t("tasks.technical.id"),
          value: <span className="break-all font-mono text-xs">{task.id}</span>,
        },
        {
          label: t("tasks.technical.environment"),
          value: <EnvironmentChip environment={task.environment} testId="task-environment-chip" />,
        },
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
  );
}

function OverviewTab({
  task,
  run,
  sleepReason,
  turnsUsed,
  playbook,
  start,
  canOpenChat,
}: {
  task: Task;
  run: TaskLatestRun | null;
  sleepReason: string | null;
  turnsUsed: number | null;
  playbook: Playbook | null;
  start: StartView;
  canOpenChat: boolean;
}) {
  const { t, dateTime } = useI18n();
  const live = run && (isOpenRun(run) || run.state === "result_ready") ? run : null;
  const sleeping = live?.state === "sleeping" && sleepReason ? sleepReason : null;
  const rounds = roundBudget(run ? turnsUsed : null, task.max_turns);
  const nextCheck =
    live?.state === "sleeping" && live.next_check_at
      ? dateTime(live.next_check_at)
      : start.kind === "at"
        ? dateTime(start.at)
        : t(start.kind === "due" ? start.line : "tasks.overview.next.none");
  return (
    <TabBody testId="task-overview" summary={task.goal}>
      <div
        className={cn("grid grid-cols-2 gap-3", sleeping ? "@3xl:grid-cols-3" : null)}
        data-testid="task-tiles"
      >
        {sleeping ? (
          <KpiTile
            dense
            label={t("tasks.overview.waitingFor")}
            note={sleeping}
            testId="task-tile-waiting"
          />
        ) : null}
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
          ...(task.source_conversation_id && task.source_message_id && canOpenChat
            ? [
                {
                  label: t("tasks.overview.source"),
                  value: (
                    <a
                      href={absolute(
                        conversationMessageHref(
                          task.source_conversation_id,
                          task.source_message_id,
                        ),
                      )}
                      className="font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid="task-source-message"
                    >
                      {t("tasks.overview.sourceOpen")}
                    </a>
                  ),
                  testId: "task-source",
                },
              ]
            : []),
        ]}
      />
      <StepProgress task={task} playbook={playbook} state={run?.state ?? null} />
      {rounds ? (
        <div className="flex items-center gap-4 border-t pt-4 text-sm" data-testid="task-rounds">
          <ProgressRing
            value={rounds.used}
            total={rounds.total}
            label={t("tasks.overview.rounds", {
              used: String(rounds.used),
              total: String(rounds.total),
            })}
          />
          <p className="font-mono">
            {t("tasks.overview.rounds", {
              used: String(rounds.used),
              total: String(rounds.total),
            })}
          </p>
        </div>
      ) : null}
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
    reviewInline: boolean;
    allow(): void;
    resume(): void;
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
    return permissions.includes("task:run") && !act.reviewInline
      ? { label, variant: "primary", onClick: act.review, testId }
      : undefined;
  if (status.action === "allow")
    return permissions.includes("task:grant")
      ? { label, variant: "primary", onClick: act.allow, testId }
      : undefined;
  return permissions.includes("task:resume")
    ? { label, variant: "primary", onClick: act.resume, pending: act.resuming, testId }
    : undefined;
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
  const listedRun = items.find((run) => run.id === shownRun) ?? null;
  const fetchedRun = useTaskRun(shownRun || null, canSeeRuns && !listedRun);
  const asked = useTaskRun(latest?.id ?? null, canSeeRuns && latest?.state === "waiting");
  const question =
    latest?.state === "waiting" && waitingForKey(latest) === "tasks.overview.waiting.you"
      ? quotedQuestion(asked.data?.pending_question)
      : null;
  const playbook = useRunPlaybook(
    latest?.conversation_id ?? null,
    permissions.includes("conversation:read"),
  );
  const status = taskStatus({
    task,
    run: latest ? { ...latest, failure_code: latestRecord?.failure_code ?? null } : null,
    grantLive,
  });
  const expiry = useTaskGrantExpiry(task.id, grantLive === true);
  const nextUp = startView(task, now);
  const refresh = () => refreshTask(client, task.id);
  const failed = (failure: unknown) => reportFailure(t("common.actionFailed"), failure);

  const start = useMutation({
    mutationFn: () => startTaskRun(task.id),
    onSuccess: async () => {
      toast.success(t("tasks.started", { name: task.name }));
      await refresh();
    },
    onError: (failure) =>
      reportFailure(t(startErrorKey(failure instanceof ApiError ? failure.code : null)), failure),
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

  const reviewInline = latest?.state === "result_ready" && permissions.includes("task:run");
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
          turnsUsed={latestRecord?.turns_used ?? null}
          playbook={playbook.data ?? null}
          start={nextUp}
          canOpenChat={permissions.includes("conversation:read")}
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
      content: (
        <>
          <ScheduleTab task={task} start={nextUp} />
          <ScheduleHistory
            subject={{ kind: "task", id: task.id }}
            onOpenRun={canSeeRuns ? setShownRun : undefined}
          />
        </>
      ),
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
  const reason = failureReason(
    latest ? { state: latest.state, failure_code: latestRecord?.failure_code ?? null } : null,
  );
  const remedies = failureRemedies({
    conversationId: latest?.conversation_id,
    permissions,
    startBlocked: Boolean(startBlocked),
  });
  const chatTarget = remedies.chat;
  const failure =
    reason && latest ? (
      <ErrorNotice
        kind="taskFailed"
        testId="task-failed"
        body={t(reason)}
        primary={
          !remedies.retry
            ? undefined
            : {
                label: t("pattern.retry"),
                onClick: () => start.mutate(),
                testId: "task-failed-retry",
              }
        }
        secondary={
          chatTarget
            ? {
                label: t("remedy.chat"),
                onClick: () => void navigate({ to: chatTarget }),
                testId: "task-failed-chat",
              }
            : undefined
        }
        rows={[
          [t("tasks.run.technical.id"), latest.id],
          [t("tasks.run.technical.failureCode"), latestRecord?.failure_code ?? MISSING],
          [t("tasks.run.fact.ended"), latest.ended_at ? dateTime(latest.ended_at) : MISSING],
        ]}
      />
    ) : undefined;

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
        loading: expiry.loading,
        aside: (
          <>
            <WaitingOnApprover
              subjectId={task.id}
              permissions={permissions}
              testId="task-strip-waiting-on"
            />
            <ApprovalExpiryNote
              validUntil={expiry.validUntil}
              environment={expiry.environment}
              onRenew={permissions.includes("task:grant") ? () => setGranting(true) : undefined}
              testId="task-expiry-strip"
            />
          </>
        ),
        action: stripAction(status, latest, permissions, t, {
          review: () => setReviewing(true),
          reviewInline,
          allow: () => setGranting(true),
          resume: () => resume.mutate(),
          resuming: resume.isPending,
        }),
      }}
      notice={
        reviewInline && latest ? (
          <TaskReviewSection
            task={task}
            run={latest}
            results={stepResults(playbook.data?.steps)}
            canOpen={permissions.includes("conversation:read")}
          />
        ) : (
          failure
        )
      }
      technical={<TaskTechnicalFacts task={task} />}
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
        run={listedRun ?? fetchedRun.data ?? null}
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
      <DetailPageLoading
        testId="detail-tasks-loading"
        back={{ to: TASKS_PATH, label: t("nav.tasks") }}
      />
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
