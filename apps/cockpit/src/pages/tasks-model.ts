import type { components } from "@cli-core/engine-api/openapi";
import { conversationHref } from "@/app/links";
import { auditActionLabel } from "@/lib/audit-model";
import type { TranslationKey } from "@/lib/i18n";
import { UNCATEGORIZED } from "@/lib/workflow-category";
import {
  limitEndedLine,
  type WaitingAction,
  waitingStateKey,
  waitingView,
  waitsForPerson,
} from "./tasks-waiting";

export type Task = components["schemas"]["Task"];
export type TaskView = components["schemas"]["TaskView"];
export type TaskLatestRun = components["schemas"]["TaskLatestRun"];
export type TaskRun = components["schemas"]["TaskRun"];
export type TaskRunDetail = components["schemas"]["TaskRunDetail"];
export type TaskPlan = components["schemas"]["TaskPlan"];
export type TaskUsage = components["schemas"]["TaskUsageResponse"];
export type TaskUsagePeriod = components["schemas"]["TaskUsagePeriod"];
export type RunGlance = Pick<TaskLatestRun, "state" | "waiting_reason" | "next_check_at">;
export type TaskInput = components["schemas"]["TaskCreateInput"] & {
  environment: components["schemas"]["Task"]["environment"];
};
export type TaskRunState = TaskRun["state"];

export const TASKS_PATH = "/tasks";
export const TASK_RESULT_STEP_ID = "confirm-result";
export const TASK_LIST_PAGE = 200;

export const TASK_RUN_STATES = [
  "running",
  "waiting",
  "sleeping",
  "result_ready",
  "completed",
  "aborted",
  "failed",
] as const satisfies readonly TaskRunState[];

export type TaskDisplayState = TaskRunState | "paused" | "scheduled" | "ready";

export type TaskTone = "ok" | "info" | "warn" | "error" | "neutral";

const STATE_KEYS: Record<TaskDisplayState, TranslationKey> = {
  running: "tasks.state.running",
  waiting: "tasks.state.waiting",
  sleeping: "tasks.state.sleeping",
  result_ready: "tasks.state.result_ready",
  completed: "tasks.state.completed",
  aborted: "tasks.state.aborted",
  failed: "tasks.state.failed",
  paused: "tasks.state.paused",
  scheduled: "tasks.state.scheduled",
  ready: "tasks.state.ready",
};

const STATE_TONES: Record<TaskDisplayState, TaskTone> = {
  running: "info",
  waiting: "warn",
  sleeping: "neutral",
  result_ready: "info",
  completed: "ok",
  aborted: "neutral",
  failed: "error",
  paused: "neutral",
  scheduled: "neutral",
  ready: "neutral",
};

export function stateKey(state: TaskDisplayState): TranslationKey {
  return STATE_KEYS[state];
}

export function stateTone(state: TaskDisplayState): TaskTone {
  return STATE_TONES[state];
}

export function badgeState(tone: TaskTone): string {
  return tone === "info" ? "running" : tone;
}

export function stateWords(
  state: TaskDisplayState,
  run: (Pick<TaskRun, "next_check_at"> & { waiting_reason?: string | null }) | null,
  words: {
    t(key: TranslationKey, values?: Record<string, string>): string;
    time(at: string): string;
  },
): string {
  if (state === "sleeping" && run?.next_check_at)
    return words.t("tasks.state.sleepingUntil", { time: words.time(run.next_check_at) });
  const waiting = state === "waiting" ? waitingStateKey({ state, ...run }) : null;
  return words.t(waiting ?? STATE_KEYS[state]);
}

export function hasSchedule(
  task: Pick<Task, "schedule_cron" | "schedule_run_at" | "last_claimed_at">,
): boolean {
  if (task.schedule_cron) return true;
  return Boolean(task.schedule_run_at) && !task.last_claimed_at;
}

export function displayState(
  task: Pick<Task, "paused_at" | "schedule_cron" | "schedule_run_at" | "last_claimed_at">,
  run: Pick<TaskRun, "state"> | null,
): TaskDisplayState {
  if (task.paused_at) return "paused";
  if (run) return run.state;
  return hasSchedule(task) ? "scheduled" : "ready";
}

export const OPEN_RUN_STATES: readonly TaskRunState[] = ["running", "waiting", "sleeping"];

export function isOpenRun(run: Pick<TaskRun, "state"> | null | undefined): boolean {
  return Boolean(run) && OPEN_RUN_STATES.includes((run as Pick<TaskRun, "state">).state);
}

export type StartView =
  | { kind: "none" }
  | { kind: "due"; line: TranslationKey }
  | { kind: "at"; at: string };

function dueLine(task: Pick<TaskView, "grant_live" | "latest_run">): TranslationKey {
  if (!task.grant_live) return "tasks.next.due";
  return isOpenRun(task.latest_run) ? "tasks.next.dueRun" : "tasks.next.dueSoon";
}

export function startView(
  task: Pick<TaskView, "paused_at" | "next_start_at" | "grant_live" | "latest_run">,
  now: number,
): StartView {
  if (task.paused_at || !task.next_start_at) return { kind: "none" };
  const at = Date.parse(task.next_start_at);
  if (Number.isNaN(at)) return { kind: "none" };
  return at <= now ? { kind: "due", line: dueLine(task) } : { kind: "at", at: task.next_start_at };
}

const QUESTION_LIMIT = 160;

export function quotedQuestion(question: string | null | undefined): string | null {
  const text = (question ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > QUESTION_LIMIT ? `${text.slice(0, QUESTION_LIMIT - 1).trimEnd()}…` : text;
}

export type UsageFigure =
  | { kind: "removed" }
  | { kind: "none" }
  | { kind: "cost"; amount: number; currency: string; atLeast: boolean }
  | { kind: "tokens"; tokens: number };

export function usageFigure(period: TaskUsagePeriod): UsageFigure {
  if (period.attribution === "conversation_removed") return { kind: "removed" };
  if (period.calls === 0) return { kind: "none" };
  if (!period.cost) return { kind: "tokens", tokens: period.tokens };
  return {
    kind: "cost",
    amount: period.cost.amount,
    currency: period.cost.currency,
    atLeast: period.cost.unpriced_models.length > 0,
  };
}

export function usageExcludesWorkflowCalls(usage: TaskUsage): boolean {
  return [usage.last_run, usage.current_month].some((period) =>
    period.not_included.includes("workflow_run_model_calls"),
  );
}

export type TaskAction = WaitingAction | "review" | "allow" | "resume";

export type TaskStatusKind =
  | "paused"
  | "waiting"
  | "result_ready"
  | "failed"
  | "grant_required"
  | "running"
  | "sleeping"
  | "completed"
  | "aborted"
  | "scheduled"
  | "ready";

export interface TaskStatus {
  kind: TaskStatusKind;
  tone: Exclude<TaskTone, "neutral">;
  line: TranslationKey;
  action: TaskAction | null;
}

const ACTION_KEYS: Record<TaskAction, TranslationKey> = {
  answer: "tasks.action.answer",
  continue: "tasks.action.continue",
  usage: "tasks.action.usage",
  ai_access: "tasks.action.aiAccess",
  review: "tasks.action.review",
  allow: "tasks.action.allow",
  resume: "tasks.action.resume",
};

export function actionKey(action: TaskAction): TranslationKey {
  return ACTION_KEYS[action];
}

export function taskStatus(input: {
  task: Pick<
    Task,
    "paused_at" | "paused_reason" | "schedule_cron" | "schedule_run_at" | "last_claimed_at"
  >;
  run: (Pick<TaskRun, "state" | "waiting_reason"> & { failure_code?: string | null }) | null;
  grantLive: boolean | null;
}): TaskStatus {
  const { task, run, grantLive } = input;
  if (task.paused_at)
    return {
      kind: "paused",
      tone: "info",
      line:
        task.paused_reason === "owner_unavailable"
          ? "tasks.strip.pausedOwner"
          : "tasks.strip.paused",
      action: "resume",
    };
  if (run?.state === "waiting") {
    const waiting = waitingView(run.waiting_reason);
    return {
      kind: "waiting",
      tone: waiting.party === "you" ? "warn" : "info",
      line: waiting.line,
      action: waiting.action,
    };
  }
  if (run?.state === "result_ready")
    return {
      kind: "result_ready",
      tone: "info",
      line: "tasks.strip.result_ready",
      action: "review",
    };
  if (run?.state === "failed")
    return { kind: "failed", tone: "error", line: "tasks.strip.failed", action: null };
  if (run?.state === "running")
    return { kind: "running", tone: "info", line: "tasks.strip.running", action: null };
  if (run?.state === "sleeping")
    return { kind: "sleeping", tone: "info", line: "tasks.strip.sleeping", action: null };
  if (hasSchedule(task) && grantLive === false)
    return {
      kind: "grant_required",
      tone: "warn",
      line: "tasks.strip.grant_required",
      action: "allow",
    };
  if (run?.state === "completed")
    return { kind: "completed", tone: "ok", line: "tasks.strip.completed", action: null };
  if (run?.state === "aborted")
    return { kind: "aborted", tone: "info", line: "tasks.strip.aborted", action: null };
  if (hasSchedule(task))
    return { kind: "scheduled", tone: "ok", line: "tasks.strip.scheduled", action: null };
  return { kind: "ready", tone: "info", line: "tasks.strip.ready", action: null };
}

export const TASK_FILTERS = ["all", "waiting", "scheduled", "paused"] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];

export function isTaskFilter(value: string): value is TaskFilter {
  return (TASK_FILTERS as readonly string[]).includes(value);
}

export interface TaskRow {
  task: TaskView;
  run: RunGlance | null;
}

export function taskRows(tasks: readonly TaskView[]): TaskRow[] {
  return tasks.map((task) => ({ task, run: task.latest_run }));
}

export function needsPerson(row: TaskRow): boolean {
  return !row.task.paused_at && waitsForPerson(row.run);
}

export function matchesFilter(row: TaskRow, filter: TaskFilter): boolean {
  if (filter === "waiting") return needsPerson(row);
  if (filter === "scheduled") return !row.task.paused_at && hasSchedule(row.task);
  if (filter === "paused") return Boolean(row.task.paused_at);
  return true;
}

export interface TaskCounts {
  total: number;
  working: number;
  waiting: number;
  ai: number;
  scheduled: number;
}

export function taskCounts(rows: readonly TaskRow[]): TaskCounts {
  return {
    total: rows.length,
    working: rows.filter(
      (row) =>
        !row.task.paused_at && (row.run?.state === "running" || row.run?.state === "sleeping"),
    ).length,
    waiting: rows.filter(needsPerson).length,
    ai: rows.filter(
      (row) => !row.task.paused_at && row.run?.state === "waiting" && !waitsForPerson(row.run),
    ).length,
    scheduled: rows.filter((row) => matchesFilter(row, "scheduled")).length,
  };
}

export type SummaryPart = {
  key:
    | "tasks.summary.working"
    | "tasks.summary.waiting"
    | "tasks.summary.ai"
    | "tasks.summary.scheduled"
    | "tasks.summary.total";
  count: number;
};

export function summaryParts(counts: TaskCounts): SummaryPart[] {
  const parts: SummaryPart[] = [
    { key: "tasks.summary.working" as const, count: counts.working },
    { key: "tasks.summary.waiting" as const, count: counts.waiting },
    { key: "tasks.summary.ai" as const, count: counts.ai },
    { key: "tasks.summary.scheduled" as const, count: counts.scheduled },
  ].filter((part) => part.count > 0);
  return parts.length > 0 ? parts : [{ key: "tasks.summary.total", count: counts.total }];
}

export const SCHEDULE_OPTIONS = [
  "manual",
  "once",
  "daily",
  "weekdays",
  "weekly",
  "custom",
] as const;
export type ScheduleOption = (typeof SCHEDULE_OPTIONS)[number];

export interface ScheduleDraft {
  option: ScheduleOption;
  time: string;
  weekday: number;
  runAt: string;
  cron: string;
  timezone: string;
}

export interface ScheduleFields {
  schedule_cron: string | null;
  schedule_timezone: string | null;
  schedule_run_at: string | null;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const pad = (value: number) => String(value).padStart(2, "0");

export function optionToCron(
  draft: Pick<ScheduleDraft, "option" | "time" | "weekday" | "cron">,
): string | null {
  if (draft.option === "custom") return draft.cron.trim() || null;
  const match = TIME.exec(draft.time);
  if (!match) return null;
  const minute = Number(match[2]);
  const hour = Number(match[1]);
  if (draft.option === "daily") return `${minute} ${hour} * * *`;
  if (draft.option === "weekdays") return `${minute} ${hour} * * 1-5`;
  if (draft.option === "weekly") return `${minute} ${hour} * * ${draft.weekday % 7}`;
  return null;
}

export function cronToOption(
  cron: string,
): { option: "daily" | "weekdays" | "weekly"; time: string; weekday: number } | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || day !== "*" || month !== "*")
    return null;
  if (Number(minute) > 59 || Number(hour) > 23) return null;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (weekday === "*") return { option: "daily", time, weekday: 1 };
  if (weekday === "1-5") return { option: "weekdays", time, weekday: 1 };
  if (/^[0-7]$/.test(weekday)) return { option: "weekly", time, weekday: Number(weekday) % 7 };
  return null;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function zonedParts(at: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const year = read("year");
  const month = read("month");
  const day = read("day");
  return {
    year,
    month,
    day,
    hour: read("hour"),
    minute: read("minute"),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

export function zonedInstant(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date {
  const wanted = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let guess = wanted;
  for (let round = 0; round < 3; round++) {
    const seen = zonedParts(new Date(guess), timezone);
    const shown = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    if (shown === wanted) break;
    guess += wanted - shown;
  }
  return new Date(guess);
}

export function localInputToInstant(value: string, timezone: string): string | null {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) return null;
  const instant = zonedInstant(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
    },
    timezone,
  );
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

export function instantToLocalInput(iso: string, timezone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const parts = zonedParts(at, timezone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

function validZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function scheduleDraft(
  task: Pick<Task, "schedule_cron" | "schedule_timezone" | "schedule_run_at"> | null,
  zone: string,
): ScheduleDraft {
  const timezone =
    task?.schedule_timezone && validZone(task.schedule_timezone) ? task.schedule_timezone : zone;
  const base: ScheduleDraft = {
    option: "manual",
    time: "08:00",
    weekday: 1,
    runAt: "",
    cron: "",
    timezone,
  };
  if (task?.schedule_run_at)
    return { ...base, option: "once", runAt: instantToLocalInput(task.schedule_run_at, timezone) };
  if (!task?.schedule_cron) return base;
  const known = cronToOption(task.schedule_cron);
  return known
    ? { ...base, ...known, cron: task.schedule_cron }
    : { ...base, option: "custom", cron: task.schedule_cron };
}

export type ScheduleIssue =
  | "tasks.schedule.error.time"
  | "tasks.schedule.error.runAt"
  | "tasks.schedule.error.runAtPast"
  | "tasks.schedule.error.cron";

export function scheduleFields(
  draft: ScheduleDraft,
  now: number,
): { ok: true; fields: ScheduleFields } | { ok: false; issue: ScheduleIssue } {
  if (draft.option === "manual")
    return {
      ok: true,
      fields: { schedule_cron: null, schedule_timezone: null, schedule_run_at: null },
    };
  if (draft.option === "once") {
    const at = localInputToInstant(draft.runAt, draft.timezone);
    if (!at) return { ok: false, issue: "tasks.schedule.error.runAt" };
    if (Date.parse(at) <= now) return { ok: false, issue: "tasks.schedule.error.runAtPast" };
    return {
      ok: true,
      fields: { schedule_cron: null, schedule_timezone: draft.timezone, schedule_run_at: at },
    };
  }
  const cron = optionToCron(draft);
  if (!cron)
    return {
      ok: false,
      issue: draft.option === "custom" ? "tasks.schedule.error.cron" : "tasks.schedule.error.time",
    };
  if (draft.option === "custom" && cron.split(/\s+/).length !== 5)
    return { ok: false, issue: "tasks.schedule.error.cron" };
  return {
    ok: true,
    fields: { schedule_cron: cron, schedule_timezone: draft.timezone, schedule_run_at: null },
  };
}

const NEXT_START_DAYS = 8;

export function nextStart(
  schedule: ScheduleFields & { last_claimed_at?: string | null },
  now: number,
): Date | null {
  if (schedule.schedule_run_at) {
    if (schedule.last_claimed_at) return null;
    const at = new Date(schedule.schedule_run_at);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  if (!schedule.schedule_cron) return null;
  const known = cronToOption(schedule.schedule_cron);
  const timezone = schedule.schedule_timezone ?? "UTC";
  if (!known || !validZone(timezone)) return null;
  const [hour, minute] = known.time.split(":").map(Number) as [number, number];
  const today = zonedParts(new Date(now), timezone);
  for (let offset = 0; offset < NEXT_START_DAYS; offset++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = day.getUTCDay();
    if (known.option === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (known.option === "weekly" && weekday !== known.weekday) continue;
    const candidate = zonedInstant(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour,
        minute,
      },
      timezone,
    );
    if (candidate.getTime() > now) return candidate;
  }
  return null;
}

export type RhythmWords =
  | { kind: "manual" }
  | { kind: "once"; at: string }
  | { kind: "done" }
  | { kind: "cron"; cron: string };

export function rhythm(
  task: Pick<Task, "schedule_cron" | "schedule_run_at" | "last_claimed_at">,
): RhythmWords {
  if (task.schedule_cron) return { kind: "cron", cron: task.schedule_cron };
  if (task.schedule_run_at)
    return task.last_claimed_at ? { kind: "done" } : { kind: "once", at: task.schedule_run_at };
  return { kind: "manual" };
}

export type ListNextStart = Exclude<StartView, { kind: "none" }> | RhythmWords;

export function listNextStart(
  task: Pick<
    TaskView,
    | "paused_at"
    | "next_start_at"
    | "grant_live"
    | "latest_run"
    | "schedule_cron"
    | "schedule_run_at"
    | "last_claimed_at"
  >,
  now: number,
): ListNextStart {
  const start = startView(task, now);
  return start.kind === "none" ? rhythm(task) : start;
}

export type PlanState = Extract<TaskDisplayState, "paused" | "scheduled" | "ready">;

export function planState(
  task: Pick<Task, "paused_at" | "schedule_cron" | "schedule_run_at" | "last_claimed_at">,
): PlanState {
  if (task.paused_at) return "paused";
  return hasSchedule(task) ? "scheduled" : "ready";
}

export function listStates(
  task: Pick<Task, "paused_at" | "schedule_cron" | "schedule_run_at" | "last_claimed_at">,
  run: Pick<TaskRun, "state"> | null,
): TaskDisplayState[] {
  const plan = planState(task);
  return run ? [run.state, plan] : [plan];
}

export const DEADLINE_CHOICES = [60, 240, 1440, 10080] as const;
export const EFFORT_CHOICES = [10, 20, 50, 100] as const;

export function withCurrent(choices: readonly number[], current: number): number[] {
  return choices.includes(current) ? [...choices] : [...choices, current].sort((a, b) => a - b);
}

export interface TaskDraft {
  name: string;
  nameEdited: boolean;
  goal: string;
  doneWhen: string;
  workflowIds: string[];
  connectorIds: string[];
  skillSlugs: string[];
  webSearch: boolean;
  environment: Task["environment"];
  schedule: ScheduleDraft;
  maxTurns: number;
  deadlineMinutes: number;
}

const NAME_LIMIT = 80;

export function nameFromGoal(goal: string): string {
  const first = (goal.trim().split(/(?<=[.!?])\s|\n/)[0] ?? "").replace(/[.!?]+$/, "").trim();
  if (first.length <= NAME_LIMIT) return first;
  const cut = first.slice(0, NAME_LIMIT);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trim()}…`;
}

export function emptyDraft(zone: string, seed: Partial<TaskDraft> = {}): TaskDraft {
  return {
    name: "",
    nameEdited: false,
    goal: "",
    doneWhen: "",
    workflowIds: [],
    connectorIds: [],
    skillSlugs: [],
    webSearch: false,
    environment: "prod",
    schedule: scheduleDraft(null, zone),
    maxTurns: 10,
    deadlineMinutes: 240,
    ...seed,
  };
}

export function draftFromTask(task: Task, zone: string): TaskDraft {
  return {
    name: task.name,
    nameEdited: true,
    goal: task.goal,
    doneWhen: task.done_when,
    workflowIds: [...task.bindings.workflow_ids],
    connectorIds: [...task.bindings.connector_ids],
    skillSlugs: [...task.bindings.skill_slugs],
    webSearch: task.bindings.web_search,
    environment: task.environment,
    schedule: scheduleDraft(task, zone),
    maxTurns: task.max_turns,
    deadlineMinutes: task.run_deadline_minutes,
  };
}

export function draftName(draft: Pick<TaskDraft, "name" | "nameEdited" | "goal">): string {
  return draft.nameEdited && draft.name.trim() ? draft.name.trim() : nameFromGoal(draft.goal);
}

const PLAN_TEXT_LIMIT = 600;
const FORM_STEP_ID = "work";

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= PLAN_TEXT_LIMIT ? trimmed : `${trimmed.slice(0, PLAN_TEXT_LIMIT - 1)}…`;
}

export function formPlan(name: string, goal: string, doneWhen: string): TaskPlan {
  return {
    title: clip(name),
    goal: clip(goal),
    steps: [
      {
        id: FORM_STEP_ID,
        label: clip(goal),
        criterion: { kind: "assessment", description: clip(doneWhen), result: null },
        depends_on: [],
        evidence_ids: [],
        note: null,
        progress: "open",
        next_action: null,
      },
    ],
    cancelled: false,
    completion_step_id: null,
  };
}

export function planForSave(
  existing: TaskPlan | null,
  name: string,
  goal: string,
  doneWhen: string,
): TaskPlan {
  if (!existing || existing.cancelled) return formPlan(name, goal, doneWhen);
  const work = existing.steps.filter((step) => step.id !== TASK_RESULT_STEP_ID);
  const only = work.length === 1 ? work[0] : undefined;
  if (work.length === 0) return formPlan(existing.title, goal, doneWhen);
  if (only?.id === FORM_STEP_ID && only.criterion.kind === "assessment") {
    const unchanged = existing.goal === clip(goal) && only.criterion.description === clip(doneWhen);
    return unchanged ? existing : formPlan(existing.title, goal, doneWhen);
  }
  if (existing.goal === clip(goal)) return existing;
  return {
    title: existing.title,
    goal: clip(goal),
    steps: work.map((step) => ({
      ...step,
      depends_on: step.depends_on.filter((id) => id !== TASK_RESULT_STEP_ID),
    })),
    cancelled: false,
    completion_step_id:
      existing.completion_step_id === TASK_RESULT_STEP_ID ? null : existing.completion_step_id,
  };
}

export type DraftIssue =
  | "tasks.form.error.goal"
  | "tasks.form.error.doneWhen"
  | "tasks.form.error.name"
  | ScheduleIssue;

export function taskBody(
  draft: TaskDraft,
  existing: Pick<Task, "plan" | "description" | "category"> | null,
  now: number,
): { ok: true; body: TaskInput } | { ok: false; issue: DraftIssue } {
  if (!draft.goal.trim()) return { ok: false, issue: "tasks.form.error.goal" };
  if (!draft.doneWhen.trim()) return { ok: false, issue: "tasks.form.error.doneWhen" };
  const name = draftName(draft);
  if (!name) return { ok: false, issue: "tasks.form.error.name" };
  const schedule = scheduleFields(draft.schedule, now);
  if (!schedule.ok) return schedule;
  return {
    ok: true,
    body: {
      name,
      description: existing?.description ?? null,
      ...(existing?.category && existing.category !== UNCATEGORIZED
        ? { category: existing.category }
        : {}),
      goal: draft.goal.trim(),
      done_when: draft.doneWhen.trim(),
      plan: planForSave(existing?.plan ?? null, name, draft.goal, draft.doneWhen),
      bindings: {
        workflow_ids: [...draft.workflowIds],
        connector_ids: [...draft.connectorIds],
        skill_slugs: [...draft.skillSlugs],
        web_search: draft.webSearch,
      },
      environment: draft.environment,
      ...schedule.fields,
      max_turns: draft.maxTurns,
      run_deadline_minutes: draft.deadlineMinutes,
    },
  };
}

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return Date.parse(a) === Date.parse(b);
}

const sorted = (values: readonly string[]) => [...values].sort().join("\n");

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function changesWork(task: Task, body: TaskInput): boolean {
  return (
    task.goal !== body.goal ||
    task.done_when !== body.done_when ||
    stable(task.plan) !== stable(body.plan) ||
    sorted(task.bindings.workflow_ids) !== sorted(body.bindings.workflow_ids) ||
    sorted(task.bindings.connector_ids) !== sorted(body.bindings.connector_ids) ||
    sorted(task.bindings.skill_slugs) !== sorted(body.bindings.skill_slugs) ||
    task.bindings.web_search !== body.bindings.web_search ||
    task.environment !== body.environment ||
    (task.schedule_cron ?? null) !== (body.schedule_cron ?? null) ||
    (task.schedule_timezone ?? null) !== (body.schedule_timezone ?? null) ||
    !sameInstant(task.schedule_run_at, body.schedule_run_at) ||
    task.max_turns !== body.max_turns ||
    task.run_deadline_minutes !== body.run_deadline_minutes
  );
}

export function saveWarning(
  changed: boolean,
  openRun: boolean,
  grantLive: boolean,
): TranslationKey | null {
  if (!changed) return null;
  if (openRun && grantLive) return "tasks.form.warn.both";
  if (openRun) return "tasks.form.warn.run";
  if (grantLive) return "tasks.form.warn.grant";
  return null;
}

const SAVE_ERRORS: Record<string, TranslationKey> = {
  task_revision_conflict: "tasks.form.error.conflict",
  cron_too_frequent: "tasks.schedule.error.tooFrequent",
  cron_invalid: "tasks.schedule.error.cron",
  cron_interval_form: "tasks.schedule.error.cron",
  timezone_invalid: "tasks.schedule.error.timezone",
  run_at_invalid: "tasks.schedule.error.runAt",
  run_at_past: "tasks.schedule.error.runAtPast",
  schedule_conflict: "tasks.schedule.error.cron",
};

export function saveErrorKey(code: string | null | undefined): TranslationKey {
  return (code && SAVE_ERRORS[code]) || "tasks.form.error.save";
}

const START_ERRORS: Record<string, TranslationKey> = {
  previous_run_active: "tasks.start.error.active",
  paused: "tasks.start.error.paused",
  ai_access_missing: "tasks.start.error.aiAccess",
  owner_unavailable: "tasks.start.error.owner",
};

export function startErrorKey(code: string | null | undefined): TranslationKey {
  return (code && START_ERRORS[code]) || "tasks.start.error.other";
}

const RESULT_ERRORS: Record<string, TranslationKey> = {
  task_run_not_result_ready: "tasks.review.error.changed",
  task_run_ended: "tasks.review.error.changed",
  playbook_tampered: "tasks.review.error.tampered",
  task_run_reopen_blocked: "tasks.review.error.reopen",
  human_session_required: "tasks.review.error.session",
};

export function resultErrorKey(code: string | null | undefined): TranslationKey {
  return (code && RESULT_ERRORS[code]) || "tasks.review.error.other";
}

export function bothEnvironments(
  connectors: readonly { environment?: string | null }[],
  current: Task["environment"] | null,
): boolean {
  const seen = new Set(connectors.map((connector) => connector.environment));
  return current === "dev" || (seen.has("dev") && seen.has("prod"));
}

const TRIGGER_KEYS: Record<TaskRun["trigger"], TranslationKey> = {
  manual: "tasks.trigger.manual",
  once: "tasks.trigger.once",
  cron: "tasks.trigger.cron",
};

export function triggerKey(trigger: TaskRun["trigger"]): TranslationKey {
  return TRIGGER_KEYS[trigger];
}

const FAILURE_KEYS: Record<NonNullable<TaskRun["failure_code"]>, TranslationKey> = {
  turn_failed: "tasks.failure.turn_failed",
  turn_interrupted: "tasks.failure.turn_interrupted",
  start_failed: "tasks.failure.start_failed",
  playbook_tampered: "tasks.failure.playbook_tampered",
  playbook_cancelled: "tasks.failure.playbook_cancelled",
  conversation_closed: "tasks.failure.conversation_closed",
  task_changed: "tasks.failure.task_changed",
  task_archived: "tasks.failure.task_archived",
  owner_unavailable: "tasks.failure.owner_unavailable",
  budget_exhausted: "tasks.failure.budget_exhausted",
  deadline_exceeded: "tasks.failure.deadline_exceeded",
  turn_limit_reached: "tasks.failure.turn_limit_reached",
};

export function failureKey(code: TaskRun["failure_code"]): TranslationKey | null {
  return code ? FAILURE_KEYS[code] : null;
}

export function failureRemedies(input: {
  conversationId: string | null | undefined;
  permissions: readonly string[];
  startBlocked: boolean;
}): { retry: boolean; chat: string | null } {
  return {
    retry: !input.startBlocked,
    chat:
      input.conversationId && input.permissions.includes("conversation:read")
        ? conversationHref(input.conversationId)
        : null,
  };
}

export function failureReason(
  run: { state: string; failure_code?: TaskRun["failure_code"] } | null | undefined,
): TranslationKey | null {
  if (run?.state !== "failed") return null;
  return limitEndedLine(run) ?? failureKey(run.failure_code ?? null) ?? "tasks.failure.unknown";
}

export function historyKey(action: string): TranslationKey {
  const label = auditActionLabel(action);
  return label.kind === "named" ? label.key : "tasks.history.other";
}

export function historyTone(action: string, result: string): TaskTone {
  if (result === "error" || action === "task_run.failed") return "error";
  if (result === "denied" || action === "task_run.waiting" || action === "task_run.result_ready")
    return "warn";
  if (action === "task_run.completed") return "ok";
  return "neutral";
}

export const TASK_TEMPLATES = ["invoices", "numbers", "prices"] as const;
export type TaskTemplate = (typeof TASK_TEMPLATES)[number];
