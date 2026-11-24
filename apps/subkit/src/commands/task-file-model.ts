import type { Task, TaskCreateBody, TaskUpdateBody } from "../engine-client/tasks.ts";

export interface TaskFileIssue {
  field: string;
  problem: string;
  fix: string;
}

export type TaskDefinition = TaskCreateBody & {
  environment: NonNullable<TaskCreateBody["environment"]>;
};

export type TaskFileResult =
  | { ok: true; definition: TaskDefinition; expected_revision: number | null }
  | { ok: false; issues: TaskFileIssue[] };

export type TaskScheduleFields = Pick<
  TaskDefinition,
  "schedule_cron" | "schedule_timezone" | "schedule_run_at"
>;

export type TaskScheduleResult =
  | { ok: true; schedule: Required<TaskScheduleFields> }
  | { ok: false; issues: TaskFileIssue[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORY = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STEP_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const CRITERION_KINDS = [
  "assessment",
  "resource_observed",
  "execution_succeeded",
  "human_confirmation",
];
const DEFINITION_KEYS = [
  "name",
  "description",
  "category",
  "goal",
  "done_when",
  "plan",
  "bindings",
  "environment",
  "schedule_cron",
  "schedule_timezone",
  "schedule_run_at",
  "max_turns",
  "run_deadline_minutes",
] as const;
const READ_ONLY_KEYS = [
  "id",
  "owner_id",
  "fingerprint",
  "revision",
  "lifecycle",
  "last_claimed_at",
  "paused_at",
  "paused_by",
  "paused_reason",
  "created_at",
  "updated_at",
  "latest_run",
  "standing_permission",
  "cockpit_url",
];
const BINDING_LISTS = ["workflow_ids", "connector_ids", "skill_slugs"] as const;
const INSTANT_EXAMPLE = "2026-12-01T07:00:00+01:00";

type Json = Record<string, unknown>;
type Report = (field: string, problem: string, fix: string) => void;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const characterCount = (value: string): number => [...value].length;

function text(source: Json, key: string, field: string, max: number, report: Report): void {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    report(field, "is missing or empty", `set "${key}" to a text of at most ${max} characters`);
    return;
  }
  if (characterCount(value.trim()) > max) {
    report(field, `is longer than ${max} characters`, `shorten it to ${max} characters or less`);
  }
}

function wholeNumber(source: Json, key: string, min: number, max: number, report: Report): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    report(key, `must be a whole number from ${min} to ${max}`, `set "${key}" inside that range`);
  }
}

function timezoneValid(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function instantValid(value: string): boolean {
  return INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

function checkSchedule(source: Json, report: Report): void {
  const cron = source.schedule_cron ?? null;
  const timezone = source.schedule_timezone ?? null;
  const runAt = source.schedule_run_at ?? null;
  if (cron !== null && runAt !== null) {
    report(
      "schedule_run_at",
      "is set together with schedule_cron",
      "keep one: a cron schedule repeats, a run time starts the task once",
    );
  }
  if (cron !== null) {
    if (typeof cron !== "string" || cron.trim().split(/\s+/).length !== 5) {
      report(
        "schedule_cron",
        "is not a cron expression with five fields",
        'use minute hour day month weekday, for example "0 7 * * 1-5"',
      );
    } else if (characterCount(cron) > 120) {
      report("schedule_cron", "is longer than 120 characters", "shorten the expression");
    }
  }
  if (timezone !== null) {
    if (typeof timezone !== "string" || !timezoneValid(timezone)) {
      report(
        "schedule_timezone",
        "is not a known timezone",
        'use an IANA name, for example "Europe/Berlin"',
      );
    } else if (cron === null) {
      report(
        "schedule_timezone",
        "is set without schedule_cron",
        "add schedule_cron or remove the timezone",
      );
    }
  }
  if (runAt !== null && (typeof runAt !== "string" || !instantValid(runAt))) {
    report(
      "schedule_run_at",
      "is not a full date and time with offset",
      `use an ISO instant, for example "${INSTANT_EXAMPLE}"`,
    );
  }
}

function checkBindings(value: unknown, report: Report): void {
  if (!isObject(value)) {
    report(
      "bindings",
      "is missing or not an object",
      'add "bindings" with workflow_ids, connector_ids, skill_slugs and web_search',
    );
    return;
  }
  for (const key of Object.keys(value)) {
    if (!BINDING_LISTS.some((name) => name === key) && key !== "web_search") {
      report(`bindings.${key}`, "is not a known field", "remove it");
    }
  }
  for (const key of BINDING_LISTS) {
    const field = `bindings.${key}`;
    const list = value[key];
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string" || entry === "")) {
      report(field, "is missing or not a list of texts", `set "${key}" to a list, [] when empty`);
      continue;
    }
    if (list.length > 20) report(field, "has more than 20 entries", "bind at most 20");
    if (new Set(list).size !== list.length) {
      report(field, "names an entry twice", "list every entry once");
    }
    if (key !== "skill_slugs" && list.some((entry) => !UUID.test(entry))) {
      const command = key === "workflow_ids" ? "subkit workflows list" : "subkit connectors list";
      report(field, "contains a value that is not an id", `use the ids shown by \`${command}\``);
    }
  }
  if (typeof value.web_search !== "boolean") {
    report("bindings.web_search", "is missing or not true or false", 'set "web_search" to false');
  }
}

function checkStep(step: unknown, field: string, report: Report): void {
  if (!isObject(step)) {
    report(field, "is not an object", "describe the step with id, label and criterion");
    return;
  }
  if (typeof step.id !== "string" || !STEP_ID.test(step.id)) {
    report(
      `${field}.id`,
      "is missing or not a valid step id",
      'start with a lowercase letter, then lowercase letters, digits, "-" or "_"',
    );
  }
  text(step, "label", `${field}.label`, 600, report);
  const kind = isObject(step.criterion) ? step.criterion.kind : undefined;
  if (typeof kind !== "string" || !CRITERION_KINDS.includes(kind)) {
    report(
      `${field}.criterion.kind`,
      "is missing or unknown",
      `use one of ${CRITERION_KINDS.join(", ")}`,
    );
  }
}

function checkPlan(value: unknown, report: Report): void {
  if (!isObject(value)) {
    report(
      "plan",
      "is missing or not an object",
      'add "plan" with title, goal, steps, cancelled and completion_step_id',
    );
    return;
  }
  text(value, "title", "plan.title", 600, report);
  text(value, "goal", "plan.goal", 600, report);
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 20) {
    report("plan.steps", "must be a list of 1 to 20 steps", "describe at least one step");
  } else {
    value.steps.forEach((step, index) => {
      checkStep(step, `plan.steps[${index}]`, report);
    });
  }
  if (typeof value.cancelled !== "boolean") {
    report("plan.cancelled", "is missing or not true or false", 'set "cancelled" to false');
  }
  const completion = value.completion_step_id;
  if (completion !== null && typeof completion !== "string") {
    report(
      "plan.completion_step_id",
      "is missing",
      "name the step that confirms the result, or set it to null",
    );
  }
}

function checkDefinition(source: Json, report: Report): void {
  for (const key of Object.keys(source)) {
    const known =
      DEFINITION_KEYS.some((name) => name === key) ||
      READ_ONLY_KEYS.includes(key) ||
      key === "expected_revision";
    if (!known) report(key, "is not a known field", "remove it");
  }
  text(source, "name", "name", 200, report);
  const description = source.description ?? null;
  if (
    description !== null &&
    (typeof description !== "string" || characterCount(description) > 2000)
  ) {
    report("description", "must be a text of at most 2000 characters", "shorten it or remove it");
  }
  const category = source.category;
  if (
    category !== undefined &&
    (typeof category !== "string" || characterCount(category) > 40 || !CATEGORY.test(category))
  ) {
    report(
      "category",
      "is not a valid category",
      'use lowercase letters, digits and single hyphens, for example "finance"',
    );
  }
  text(source, "goal", "goal", 600, report);
  text(source, "done_when", "done_when", 2000, report);
  checkPlan(source.plan, report);
  checkBindings(source.bindings, report);
  if (source.environment !== "dev" && source.environment !== "prod") {
    report("environment", 'must be "dev" or "prod"', 'set "environment" to "dev" or "prod"');
  }
  checkSchedule(source, report);
  wholeNumber(source, "max_turns", 1, 100, report);
  wholeNumber(source, "run_deadline_minutes", 5, 10080, report);
}

function expectedRevision(source: Json, report: Report): number | null {
  const value = source.expected_revision ?? source.revision ?? null;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    report(
      source.expected_revision === undefined ? "revision" : "expected_revision",
      "must be a whole number of at least 1",
      "use the revision shown by `subkit tasks get <id>` or remove the field",
    );
    return null;
  }
  return value;
}

export function parseTaskFile(content: string): TaskFileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issues: [{ field: "(file)", problem: `is not valid JSON: ${detail}`, fix: "fix the syntax" }],
    };
  }
  if (!isObject(parsed)) {
    return {
      ok: false,
      issues: [
        {
          field: "(file)",
          problem: "does not contain a JSON object",
          fix: "write one task as an object with name, goal, done_when, plan, bindings and environment",
        },
      ],
    };
  }
  const issues: TaskFileIssue[] = [];
  const report: Report = (field, problem, fix) => {
    issues.push({ field, problem, fix });
  };
  checkDefinition(parsed, report);
  const expected_revision = expectedRevision(parsed, report);
  if (issues.length > 0) return { ok: false, issues };
  const definition: Json = {};
  for (const key of DEFINITION_KEYS) {
    if (parsed[key] !== undefined) definition[key] = parsed[key];
  }
  return { ok: true, definition: definition as TaskDefinition, expected_revision };
}

export function describeTaskFileIssues(path: string, issues: readonly TaskFileIssue[]): string {
  const lines = issues.map((issue) => `  ${issue.field} ${issue.problem}; ${issue.fix}`);
  return [`${path} is not a valid task file:`, ...lines].join("\n");
}

export function taskDefinitionOf(task: Task): Required<TaskDefinition> {
  return {
    name: task.name,
    description: task.description,
    category: task.category,
    goal: task.goal,
    done_when: task.done_when,
    plan: task.plan,
    bindings: task.bindings,
    environment: task.environment,
    schedule_cron: task.schedule_cron,
    schedule_timezone: task.schedule_timezone,
    schedule_run_at: task.schedule_run_at,
    max_turns: task.max_turns,
    run_deadline_minutes: task.run_deadline_minutes,
  };
}

export function taskUpdateBody(
  definition: TaskDefinition,
  expected_revision: number,
): TaskUpdateBody {
  return { ...definition, expected_revision };
}

export function scheduleFromFlags(
  flags: { cron?: string | undefined; timezone?: string | undefined; runAt?: string | undefined },
  current: Required<TaskScheduleFields>,
): TaskScheduleResult {
  const issues: TaskFileIssue[] = [];
  const report: Report = (field, problem, fix) => {
    issues.push({ field, problem, fix });
  };
  if (flags.cron === undefined && flags.timezone === undefined && flags.runAt === undefined) {
    report("--file", "is missing", "pass --file <path>, --cron <expr> or --run-at <iso>");
    return { ok: false, issues };
  }
  if (flags.runAt !== undefined && (flags.cron !== undefined || flags.timezone !== undefined)) {
    report(
      "--run-at",
      "is set together with --cron or --timezone",
      "keep one: --cron repeats, --run-at starts the task once",
    );
    return { ok: false, issues };
  }
  const schedule: Required<TaskScheduleFields> =
    flags.runAt !== undefined
      ? { schedule_cron: null, schedule_timezone: null, schedule_run_at: flags.runAt }
      : {
          schedule_cron: flags.cron ?? current.schedule_cron,
          schedule_timezone: flags.timezone ?? current.schedule_timezone,
          schedule_run_at: null,
        };
  checkSchedule(schedule, (field, problem, fix) => {
    const flag = field === "schedule_cron" ? "--cron" : `--${field.slice(9).replace("_", "-")}`;
    report(
      flag,
      problem.replaceAll("schedule_cron", "--cron"),
      fix.replaceAll("schedule_cron", "--cron"),
    );
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, schedule };
}

export function describeFlagIssues(issues: readonly TaskFileIssue[]): string {
  return issues.map((issue) => `${issue.field} ${issue.problem}; ${issue.fix}`).join("\n");
}
