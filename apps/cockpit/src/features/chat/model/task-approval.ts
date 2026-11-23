import type { Translate } from "@/lib/i18n";

export const TASK_WRITE_TOOLS = ["run_task", "abort_task_run", "save_task"] as const;
export type TaskWriteTool = (typeof TASK_WRITE_TOOLS)[number];

export interface TaskWriteAction {
  tool: TaskWriteTool;
  taskId: string | null;
  taskRunId: string | null;
  name: string | null;
  scheduled: boolean;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function taskActionOf(tool: string | undefined, input: unknown): TaskWriteAction | null {
  const known = TASK_WRITE_TOOLS.find((candidate) => candidate === tool);
  if (!known) return null;
  const args =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return {
    tool: known,
    taskId: known === "abort_task_run" ? null : text(args.task_id),
    taskRunId: known === "abort_task_run" ? text(args.task_run_id) : null,
    name: known === "save_task" ? text(args.name) : null,
    scheduled:
      known === "save_task" &&
      (text(args.schedule_cron) !== null || text(args.schedule_run_at) !== null),
  };
}

export function withTaskName(
  action: TaskWriteAction,
  stored: string | null | undefined,
): TaskWriteAction {
  const name = action.name ?? text(stored);
  return name === action.name ? action : { ...action, name };
}

export function taskActionLine(
  action: TaskWriteAction,
  t: Translate,
  mark: (value: string) => string = (value) => value,
): string | null {
  const task = action.name
    ? t("chat.taskAction.task.named", { name: mark(action.name) })
    : t("chat.taskAction.task.unnamed");
  if (action.tool === "run_task") return t("chat.taskAction.run", { task });
  if (action.tool === "abort_task_run") return t("chat.taskAction.abort", { task });
  if (action.taskId) return t("chat.taskAction.update", { task });
  if (!action.name) return null;
  return t(action.scheduled ? "chat.taskAction.createScheduled" : "chat.taskAction.create", {
    name: mark(action.name),
  });
}
