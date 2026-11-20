import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { absolute, taskHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { Button, Skeleton, StatusBadge } from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { taskKeys } from "@/lib/task-keys";
import type { ConversationPlaybook } from "@/pages/chat-playbook";
import {
  newerPlaybook,
  type RunLine,
  type RunMarker,
  runCanAbort,
  runDateLabel,
  runLine,
  runPlaybook,
} from "@/pages/chat-task-run";
import { StopRunDialog } from "@/pages/tasks-stop-dialog";
import { ReadingColumn } from "./parts";

export function TaskRunLineView({
  name,
  href,
  date,
  line,
  pending,
  unavailable,
  onRetry,
  onAbort,
}: {
  name: string;
  href: string | null;
  date: string | null;
  line: RunLine | null;
  pending: boolean;
  unavailable: boolean;
  onRetry: () => void;
  onAbort: (() => void) | null;
}) {
  const { t } = useI18n();
  return (
    <ReadingColumn className="shrink-0 border-b py-2" testId="chat-task-run">
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm" data-testid="chat-task-run-title">
            {href ? (
              <a
                className="font-medium underline-offset-4 hover:underline"
                href={href}
                data-testid="chat-task-run-task"
              >
                {name}
              </a>
            ) : (
              <span className="font-medium">{name}</span>
            )}
            {date ? (
              <span className="text-muted-foreground">
                {" · "}
                {t("chat.taskRun.runOf", { date })}
              </span>
            ) : null}
          </p>
          {pending ? (
            <Skeleton className="mt-1 h-4 w-48" />
          ) : unavailable ? (
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid="chat-task-run-unavailable"
            >
              {t("chat.taskRun.unavailable")}
            </p>
          ) : line ? (
            <p
              className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
              data-testid="chat-task-run-facts"
            >
              {line.state ? (
                <StatusBadge
                  state={line.state.badge}
                  label={line.state.label}
                  testId="chat-task-run-state"
                />
              ) : null}
              {line.facts.map((fact) => (
                <span key={fact} className="min-w-0 break-words">
                  {"· "}
                  {fact}
                </span>
              ))}
            </p>
          ) : null}
        </div>
        {unavailable && !pending ? (
          <Button variant="outline" size="sm" onClick={onRetry} data-testid="chat-task-run-retry">
            {t("session.retry")}
          </Button>
        ) : onAbort ? (
          <Button variant="outline" size="sm" onClick={onAbort} data-testid="chat-task-run-abort">
            {t("chat.taskRun.abort")}
          </Button>
        ) : null}
      </div>
    </ReadingColumn>
  );
}

export function useRunOfConversation(runId: string, permissions: readonly string[]) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: taskKeys.run(runId),
    enabled: Boolean(runId) && permissions.includes("task_run:read"),
    retry: false,
    queryFn: () => apiCall("get", "/v1/task-runs/{id}", { path: { id: runId } }),
    ...live,
  });
}

export function TaskRunLine({
  marker,
  conversationId,
  playbook,
  permissions,
  refreshedAt,
}: {
  marker: RunMarker;
  conversationId: string;
  playbook: ConversationPlaybook | null;
  permissions: readonly string[];
  refreshedAt: number;
}) {
  const { t, locale } = useI18n();
  const live = useLiveQueryOptions();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const runId = marker.taskRunId ?? "";
  const taskId = marker.taskId ?? "";
  const run = useRunOfConversation(runId, permissions);
  const task = useQuery({
    queryKey: taskKeys.detail(taskId),
    enabled: Boolean(taskId) && permissions.includes("task:read"),
    retry: false,
    queryFn: () => apiCall("get", "/v1/tasks/{id}", { path: { id: taskId } }),
    ...live,
  });
  const refreshed = useQuery({
    queryKey: taskKeys.playbook(conversationId),
    enabled: permissions.includes("conversation:read"),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    initialData: playbook,
    initialDataUpdatedAt: refreshedAt,
    queryFn: async () =>
      (await apiCall("get", "/v1/conversations/{id}", { path: { id: conversationId } })).playbook ??
      null,
  });
  const stored = newerPlaybook(
    { playbook, at: refreshedAt },
    { playbook: refreshed.data, at: refreshed.dataUpdatedAt },
  );
  const shown = stored ? runPlaybook(stored, t, run.data?.state) : null;
  const refetchRun = run.refetch;
  useEffect(() => {
    if (refreshedAt > 0 && runId) void refetchRun({ cancelRefetch: false });
  }, [refreshedAt, runId, refetchRun]);
  const abort = useMutation({
    mutationFn: () => apiCall("post", "/v1/task-runs/{id}/abort", { path: { id: runId } }),
    onSettled: async () => {
      setConfirming(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: taskKeys.runDetails }),
        queryClient.invalidateQueries({ queryKey: taskKeys.details }),
        queryClient.invalidateQueries({ queryKey: taskKeys.lists }),
        queryClient.invalidateQueries({ queryKey: taskKeys.runsOf(taskId) }),
        queryClient.invalidateQueries({ queryKey: ["attention"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }),
      ]);
    },
    onError: (error) => {
      if (!(error instanceof ApiError && error.status === 409))
        reportFailure(t("chat.taskRun.abort.failed"), error);
    },
  });
  const name = task.data?.name?.trim() || t("chat.taskRun.unnamed");
  const data = run.data ?? null;
  return (
    <>
      <TaskRunLineView
        name={name}
        href={taskId && permissions.includes("task:read") ? absolute(taskHref(taskId)) : null}
        date={data ? runDateLabel(locale, data.created_at) : null}
        line={data ? runLine({ run: data, playbook: shown, now: Date.now() }, locale, t) : null}
        pending={run.isPending && run.fetchStatus !== "idle"}
        unavailable={!data && !(run.isPending && run.fetchStatus !== "idle")}
        onRetry={() => void run.refetch()}
        onAbort={data && runCanAbort(data.state, permissions) ? () => setConfirming(true) : null}
      />
      <StopRunDialog
        name={task.data?.name?.trim() || null}
        open={confirming}
        onOpenChange={setConfirming}
        pending={abort.isPending}
        onConfirm={() =>
          abort.mutateAsync().then(
            () => undefined,
            () => undefined,
          )
        }
        testId="chat-task-run-abort-dialog"
      />
    </>
  );
}
