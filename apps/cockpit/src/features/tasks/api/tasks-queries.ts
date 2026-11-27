import { type QueryClient, useQuery } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { invalidationBatcher } from "@/app/invalidation-batcher";
import { useLiveQueryOptions } from "@/app/live-events";
import { taskKeys } from "@/features/tasks/model/task-keys";
import { TASK_LIST_PAGE, type TaskInput, type TaskView } from "../model/tasks-model";

export { taskKeys };

const RUN_PAGE = 50;
const HISTORY_PAGE = 50;

export async function listAllTasks(q: string): Promise<{ items: TaskView[]; total: number }> {
  const items: TaskView[] = [];
  for (;;) {
    const page = await apiCall("get", "/v1/tasks", {
      query: {
        lifecycle: "active",
        q: q || undefined,
        sort: "updated_at",
        order: "desc",
        limit: TASK_LIST_PAGE,
        offset: items.length,
      },
    });
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total)
      return { items, total: Math.max(page.total, items.length) };
  }
}

export function useTasks(q: string, enabled: boolean) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: taskKeys.list(q),
    queryFn: () => listAllTasks(q),
    enabled,
    ...live,
  });
}

export function useConversationTasks(conversationId: string | null, enabled: boolean) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: taskKeys.fromConversation(conversationId ?? ""),
    queryFn: () =>
      apiCall("get", "/v1/tasks", {
        query: {
          source_conversation_id: conversationId ?? undefined,
          sort: "created_at",
          order: "asc",
          limit: TASK_LIST_PAGE,
        },
      }),
    enabled: enabled && Boolean(conversationId),
    ...live,
  });
}

export function useTask(id: string, enabled: boolean) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: taskKeys.detail(id),
    queryFn: () => apiCall("get", "/v1/tasks/{id}", { path: { id } }),
    enabled: enabled && Boolean(id),
    ...live,
  });
}

const listTaskRunPage = (id: string, offset: number) =>
  apiCall("get", "/v1/tasks/{id}/runs", { path: { id }, query: { limit: RUN_PAGE, offset } });

export async function listAllTaskRuns(id: string) {
  const items: Awaited<ReturnType<typeof listTaskRunPage>>["items"] = [];
  for (;;) {
    const page = await listTaskRunPage(id, items.length);
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total)
      return { items, total: Math.max(page.total, items.length) };
  }
}

export function useTaskRuns(id: string, enabled: boolean) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: taskKeys.runs(id),
    queryFn: () => listAllTaskRuns(id),
    enabled: enabled && Boolean(id),
    ...live,
  });
}

export function useTaskRun(runId: string | null, enabled: boolean) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: taskKeys.run(runId ?? ""),
    queryFn: () => apiCall("get", "/v1/task-runs/{id}", { path: { id: runId ?? "" } }),
    enabled: enabled && Boolean(runId),
    retry: false,
    ...live,
  });
}

export function useTaskUsage(id: string, enabled: boolean) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: taskKeys.usage(id),
    queryFn: () => apiCall("get", "/v1/tasks/{id}/usage", { path: { id } }),
    enabled: enabled && Boolean(id),
    ...live,
  });
}

export function useTaskHistory(id: string, enabled: boolean) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: taskKeys.history(id),
    queryFn: () => apiCall("get", "/v1/audit-log", { query: { task_id: id, limit: HISTORY_PAGE } }),
    enabled: enabled && Boolean(id),
    ...live,
  });
}

export function useRunPlaybook(conversationId: string | null, enabled: boolean) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: taskKeys.playbook(conversationId ?? ""),
    queryFn: async () =>
      (await apiCall("get", "/v1/conversations/{id}", { path: { id: conversationId ?? "" } }))
        .playbook ?? null,
    enabled: enabled && Boolean(conversationId),
    ...live,
  });
}

export function createTask(body: TaskInput) {
  return apiCall("post", "/v1/tasks", { body });
}

export function updateTask(id: string, body: TaskInput, expectedRevision: number) {
  return apiCall("put", "/v1/tasks/{id}", {
    path: { id },
    body: { ...body, expected_revision: expectedRevision },
  });
}

export function deleteTask(id: string) {
  return apiCall("delete", "/v1/tasks/{id}", { path: { id } });
}

export function pauseTask(id: string) {
  return apiCall("post", "/v1/tasks/{id}/pause", { path: { id } });
}

export function resumeTask(id: string) {
  return apiCall("post", "/v1/tasks/{id}/resume", { path: { id } });
}

export function startTaskRun(id: string) {
  return apiCall("post", "/v1/tasks/{id}/runs", { path: { id } });
}

export function abortTaskRun(id: string) {
  return apiCall("post", "/v1/task-runs/{id}/abort", { path: { id } });
}

export function continueTaskRunInNewConversation(id: string) {
  return apiCall("post", "/v1/task-runs/{id}/new-conversation", { path: { id } });
}

export function completeTaskRun(id: string) {
  return apiCall("post", "/v1/task-runs/{id}/complete", { path: { id } });
}

export function rejectTaskRun(id: string) {
  return apiCall("post", "/v1/task-runs/{id}/reject", { path: { id } });
}

export async function refreshTask(client: QueryClient, id: string): Promise<void> {
  await Promise.all([
    invalidationBatcher(client).now([["attention"]]),
    client.invalidateQueries({ queryKey: taskKeys.lists }),
    client.invalidateQueries({ queryKey: taskKeys.detail(id) }),
    client.invalidateQueries({ queryKey: taskKeys.runsOf(id) }),
    client.invalidateQueries({ queryKey: taskKeys.runDetails }),
    client.invalidateQueries({ queryKey: taskKeys.grantsOf(id) }),
    client.invalidateQueries({ queryKey: taskKeys.usage(id) }),
  ]);
}
