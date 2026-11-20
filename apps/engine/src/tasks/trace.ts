import { getContext, type LogContext, withContext } from "../logging/context.ts";

export interface TaskRunTraceSource {
  trace_id: string;
  trigger: string;
  conversation_id: string | null;
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const SCHEDULED_TRIGGERS: ReadonlySet<string> = new Set(["cron", "once"]);

export function taskRunLogContext(run: TaskRunTraceSource): LogContext {
  const context: LogContext = { audit_access_type: "task_run" };
  if (TRACE_ID.test(run.trace_id)) {
    context.trace_id = run.trace_id;
    context.audit_trace_id = run.trace_id;
  }
  if (SCHEDULED_TRIGGERS.has(run.trigger)) context.audit_origin_source = "scheduler";
  if (run.conversation_id) context.conversation_id = run.conversation_id;
  return context;
}

export function isBackgroundTaskContext(context: LogContext): boolean {
  if (context.session_id || context.api_key_id) return false;
  return context.audit_access_type === undefined || context.audit_access_type === "task_run";
}

export function withTaskRunTrace<T>(run: TaskRunTraceSource, fn: () => T): T {
  if (!isBackgroundTaskContext(getContext())) return fn();
  return withContext(taskRunLogContext(run), fn);
}

export function withTaskRunAuditTrace<T>(
  run: Pick<TaskRunTraceSource, "trace_id">,
  fn: () => T,
): T {
  if (!isBackgroundTaskContext(getContext()) || !TRACE_ID.test(run.trace_id)) return fn();
  return withContext({ audit_trace_id: run.trace_id }, fn);
}
