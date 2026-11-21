export const LOCAL_RUN_TRIGGERS = [
  "chat",
  "task",
  "schedule",
  "manual_run",
  "webhook",
  "api",
  "mcp",
  "workflow_call",
  "content",
] as const;
export type LocalRunTrigger = (typeof LOCAL_RUN_TRIGGERS)[number];

export const LOCAL_SOURCE_REFUSALS = [
  "started_by_someone_else",
  "schedule_by_someone_else",
  "trigger_not_allowed",
] as const;
export type LocalSourceRefusal = (typeof LOCAL_SOURCE_REFUSALS)[number];

export interface LocalRunSource {
  trigger: LocalRunTrigger;
  started_by: string | null;
  schedule_created_by: string | null;
  device_owner: string;
}

const PERSON_STARTED: ReadonlySet<LocalRunTrigger> = new Set(["chat", "task", "manual_run"]);

export function localAgenticRefusal(source: LocalRunSource): LocalSourceRefusal | null {
  if (PERSON_STARTED.has(source.trigger))
    return source.started_by === source.device_owner ? null : "started_by_someone_else";
  if (source.trigger === "schedule")
    return source.schedule_created_by === source.device_owner ? null : "schedule_by_someone_else";
  return "trigger_not_allowed";
}

export function taskRunSource(
  task: { readonly started_by: string | null; readonly owner_id: string },
  device_owner: string,
): LocalRunSource {
  return task.started_by === null
    ? { trigger: "schedule", started_by: null, schedule_created_by: task.owner_id, device_owner }
    : { trigger: "task", started_by: task.started_by, schedule_created_by: null, device_owner };
}
