type Card = Record<string, unknown>;

function record(input: unknown): Card {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Card) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function counted(count: number, one: string, many: string): string | null {
  if (count === 0) return null;
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function listed(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function scheduleClause(input: Card, update: boolean): string {
  const cron = text(input.schedule_cron);
  const once = text(input.schedule_run_at);
  if (cron)
    return `it runs on the schedule ${cron} (${text(input.schedule_timezone) ?? "UTC"}) once it has its standing permission`;
  if (once) return `it runs once at ${once} once it has its standing permission`;
  if (update && input.schedule_cron === undefined && input.schedule_run_at === undefined)
    return "its schedule stays as it is";
  return "it runs only when someone starts it";
}

function bindingsClause(input: Card, update: boolean): string {
  const given = ["workflow_ids", "connector_ids", "skill_slugs", "web_search"].some(
    (key) => input[key] !== undefined,
  );
  if (update && !given) return "what it may use stays as it is";
  const size = (key: string) => (Array.isArray(input[key]) ? (input[key] as unknown[]).length : 0);
  const parts = [
    counted(size("workflow_ids"), "workflow", "workflows"),
    counted(size("connector_ids"), "connector", "connectors"),
    counted(size("skill_slugs"), "skill", "skills"),
    input.web_search === true ? "web search" : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0
    ? "it may use no workflow, connector, skill or web search"
    : `it may use ${listed(parts)}`;
}

export function saveTaskCard(raw: unknown, stored_name: string | null = null): Card {
  const input = record(raw);
  const task_id = text(input.task_id);
  const name = text(input.name);
  const update = task_id !== null;
  const shown = name ?? stored_name;
  const subject = shown ? `the task “${shown}”` : update ? `the task ${task_id}` : "a new task";
  return {
    summary: `${update ? "Update" : "Save"} ${subject}: ${scheduleClause(input, update)}, and ${bindingsClause(input, update)}.`,
    ...(task_id ? { task_id } : {}),
    ...(name ? { name } : {}),
    ...(text(input.environment) ? { environment: input.environment } : {}),
  };
}

export function runTaskCard(raw: unknown, task_name: string | null = null): Card {
  const task_id = text(record(raw).task_id);
  const subject = task_name ? `“${task_name}”` : (task_id ?? "(unknown)");
  return {
    summary: `Start a run of the task ${subject} now, in its own conversation.`,
    task_id,
  };
}

export function abortTaskRunCard(raw: unknown, task_name: string | null = null): Card {
  const task_run_id = text(record(raw).task_run_id);
  const subject = task_name
    ? `the current run of the task “${task_name}”`
    : `the task run ${task_run_id ?? "(unknown)"}`;
  return {
    summary: `Stop ${subject}; it cannot be continued afterwards.`,
    task_run_id,
  };
}
