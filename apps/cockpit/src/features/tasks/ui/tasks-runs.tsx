import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import { absolute, conversationHref } from "@/app/links";
import {
  ActionButton,
  ActionMenu,
  Button,
  type CockpitColumn,
  DataState,
  DataTable,
  type DialogError,
  dialogFailure,
  type Fact,
  FactList,
  FormDialog,
  RecordSheet,
  StatusBadge,
  TabBody,
  TechnicalDetails,
} from "@/components/cockpit/patterns";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { useI18n } from "@/lib/i18n-context";
import { completeTaskRun, refreshTask, rejectTaskRun } from "../api/tasks-queries";
import {
  badgeState,
  failureKey,
  resultErrorKey,
  stateTone,
  stateWords,
  type Task,
  type TaskRun,
  taskRunContinueHref,
  triggerKey,
} from "../model/tasks-model";
import type { StepResult } from "../model/tasks-steps";

export function RunStateBadge({ run, testId }: { run: TaskRun; testId?: string }) {
  const { t, dateTime } = useI18n();
  return (
    <StatusBadge
      state={badgeState(stateTone(run.state))}
      label={stateWords(run.state, run, { t, time: dateTime })}
      testId={testId}
    />
  );
}

export function TaskRunsTab({
  runs,
  total,
  pending,
  failed,
  onRetry,
  onOpen,
}: {
  runs: TaskRun[];
  total: number | undefined;
  pending: boolean;
  failed: boolean;
  onRetry(): void;
  onOpen(run: TaskRun): void;
}) {
  const { t, tn, dateTime } = useI18n();
  const columns = useMemo<CockpitColumn<TaskRun>[]>(() => {
    const column = tableColumns<TaskRun>({ t, dateTime });
    return [
      column.date("created_at", (row) => row.created_at, t("tasks.runs.column.started"), {
        width: "w-[30%]",
        cardLabel: false,
      }),
      column.custom(
        "state",
        (row) => row.state,
        t("tasks.runs.column.state"),
        (row) => <RunStateBadge run={row} />,
        { width: "w-[28%]" },
      ),
      column.custom(
        "trigger",
        (row) => row.trigger,
        t("tasks.runs.column.trigger"),
        (row) => t(triggerKey(row.trigger)),
        { width: "w-[20%]", priority: "low" },
      ),
      column.date("ended_at", (row) => row.ended_at, t("tasks.runs.column.ended"), {
        width: "w-[22%]",
        priority: "low",
      }),
    ];
  }, [t, dateTime]);
  return (
    <TabBody
      testId="task-runs"
      summary={pending || failed ? undefined : tn("tasks.runs.summary", total ?? runs.length)}
    >
      <DataTable
        columns={columns}
        data={runs}
        sorting={[]}
        onSortingChange={() => undefined}
        onOpen={onOpen}
        rowLabel={(row) => t("tasks.runs.open", { date: dateTime(row.created_at) })}
        getRowId={(row) => row.id}
        pending={pending}
        error={
          failed
            ? {
                title: t("tasks.runs.loadFailed"),
                description: t("resource.loadFailedDescription"),
                retryLabel: t("session.retry"),
                onRetry,
              }
            : null
        }
        emptyState={{
          zero: { title: t("tasks.runs.none") },
          filtered: {
            title: t("tasks.runs.none"),
            description: t("resource.broaderSearch"),
            resetLabel: t("catalog.clearFilters"),
            onReset: () => undefined,
          },
        }}
        hasActiveFilters={false}
        total={total}
        columnsLabel={t("catalog.columns")}
        actionsLabel={t("common.actions")}
        collectionId="task-runs"
        collectionTier="embedded"
        pickColumns={false}
      />
    </TabBody>
  );
}

export function TaskRunSheet({
  task,
  run,
  onClose,
  permissions,
}: {
  task: Task;
  run: TaskRun | null;
  onClose(): void;
  permissions: readonly string[];
}) {
  const { t, dateTime } = useI18n();
  if (!run) return null;
  const failure = failureKey(run.failure_code);
  const facts: Fact[] = [
    {
      label: t("tasks.run.fact.state"),
      value: <RunStateBadge run={run} />,
      testId: "task-run-state",
    },
    { label: t("tasks.run.fact.started"), value: dateTime(run.created_at) },
    { label: t("tasks.run.fact.trigger"), value: t(triggerKey(run.trigger)) },
    ...(run.ended_at ? [{ label: t("tasks.run.fact.ended"), value: dateTime(run.ended_at) }] : []),
    ...(run.state === "sleeping" && run.next_check_at
      ? [{ label: t("tasks.run.fact.nextCheck"), value: dateTime(run.next_check_at) }]
      : []),
    ...(run.state === "sleeping" && run.sleep_reason
      ? [{ label: t("tasks.run.fact.reason"), value: run.sleep_reason }]
      : []),
    ...(failure
      ? [{ label: t("tasks.run.fact.failure"), value: t(failure), testId: "task-run-failure" }]
      : []),
  ];
  const canContinue = run.state === "completed" && permissions.includes("conversation:write");
  return (
    <RecordSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("tasks.run.title", { date: dateTime(run.created_at) })}
      subtitle={task.name}
      action={
        run.conversation_id && permissions.includes("conversation:read") ? (
          <Button asChild>
            <a href={absolute(conversationHref(run.conversation_id))} data-testid="task-run-open">
              {t("tasks.run.open")}
            </a>
          </Button>
        ) : undefined
      }
      menu={
        canContinue ? (
          <ActionMenu
            testId="task-run-menu"
            items={[
              {
                label: t("tasks.run.continue"),
                href: absolute(taskRunContinueHref(task, run, { t, time: dateTime })),
                testId: "task-run-continue",
              },
            ]}
          />
        ) : undefined
      }
      testId="task-run-sheet"
    >
      <div className="flex flex-col gap-6">
        <FactList items={facts} testId="task-run-facts" />
        {run.conversation_id ? null : (
          <DataState
            state="empty"
            line={t("tasks.run.noConversation")}
            testId="task-run-no-conversation"
          />
        )}
        <TechnicalDetails testId="task-run-technical">
          <FactList
            items={[
              {
                label: t("tasks.run.technical.id"),
                value: <span className="break-all font-mono text-xs">{run.id}</span>,
              },
              {
                label: t("tasks.run.technical.trace"),
                value: <span className="break-all font-mono text-xs">{run.trace_id}</span>,
              },
              { label: t("tasks.run.technical.turns"), value: String(run.turns_used) },
              { label: t("tasks.run.technical.revision"), value: String(run.task_revision) },
              {
                label: t("tasks.run.technical.failureCode"),
                value: run.failure_code ? (
                  <span className="font-mono text-xs">{run.failure_code}</span>
                ) : (
                  MISSING
                ),
              },
            ]}
          />
        </TechnicalDetails>
      </div>
    </RecordSheet>
  );
}

export function TaskReviewDialog({
  task,
  run,
  results = [],
  open,
  onOpenChange,
  canOpen,
}: {
  task: Task;
  run: Pick<TaskRun, "id" | "conversation_id">;
  results?: readonly StepResult[];
  open: boolean;
  onOpenChange(open: boolean): void;
  canOpen: boolean;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [error, setError] = useState<DialogError>(null);
  const decide = useMutation({
    mutationFn: (decision: "accept" | "reject") =>
      decision === "accept" ? completeTaskRun(run.id) : rejectTaskRun(run.id),
    onSuccess: async (_run, decision) => {
      toast.success(
        t(decision === "accept" ? "tasks.review.accepted" : "tasks.review.rejected", {
          name: task.name,
        }),
      );
      await refreshTask(client, task.id);
      onOpenChange(false);
    },
    onError: async (failure) => {
      setError(
        dialogFailure(
          t(resultErrorKey(failure instanceof ApiError ? failure.code : null)),
          failure,
        ),
      );
      await refreshTask(client, task.id);
    },
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("tasks.review.titleNamed", { name: task.name })}
      description={results.length > 0 ? undefined : t("tasks.review.line")}
      size="wide"
      submit={{
        label: t("tasks.review.accept"),
        pending: decide.isPending,
        testId: "task-review-accept",
      }}
      onSubmit={() => {
        setError(null);
        decide.mutate("accept");
      }}
      actions={
        <ActionButton
          disabled={decide.isPending}
          onClick={() => {
            setError(null);
            decide.mutate("reject");
          }}
          testId="task-review-reject"
        >
          {t("tasks.review.reject")}
        </ActionButton>
      }
      error={error}
      testId="task-review"
    >
      {results.length > 0 ? (
        <>
          <FactList
            testId="task-review-yardstick"
            items={[
              {
                label: t("tasks.overview.doneWhen"),
                value: <span className="[overflow-wrap:anywhere]">{task.done_when}</span>,
              },
            ]}
          />
          <ul
            className="flex min-w-0 flex-col divide-y rounded-lg border"
            data-testid="task-review-results"
          >
            {results.map((result) => (
              <li key={result.id} className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
                <span className="text-xs font-medium text-muted-foreground [overflow-wrap:anywhere]">
                  {result.label}
                </span>
                <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {result.text}
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {run.conversation_id && canOpen ? (
        <a
          href={absolute(conversationHref(run.conversation_id))}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="task-review-open"
        >
          {t("tasks.review.open")}
        </a>
      ) : (
        <p className="text-muted-foreground text-sm" data-testid="task-review-no-conversation">
          {t("tasks.run.noConversation")}
        </p>
      )}
    </FormDialog>
  );
}
