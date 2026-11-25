import { readFileSync } from "node:fs";
import { emitList, emitOne, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import type { Task, TaskGrant, TaskRun, TaskView } from "../engine-client/tasks.ts";
import type { EngineClient } from "../engine-client.ts";
import { cockpitUrl } from "../lib/intake-review.ts";
import { makeClient, withCommandErrors } from "./command-runtime.ts";
import {
  describeFlagIssues,
  describeTaskFileIssues,
  parseTaskFile,
  scheduleFromFlags,
  type TaskDefinition,
  taskDefinitionOf,
  taskUpdateBody,
} from "./task-file-model.ts";

export type TaskCommandClient = Pick<
  EngineClient,
  | "base"
  | "listTasks"
  | "getTask"
  | "createTask"
  | "updateTask"
  | "deleteTask"
  | "pauseTask"
  | "resumeTask"
  | "startTaskRun"
  | "listTaskRuns"
  | "abortTaskRun"
  | "listTaskGrants"
>;

export interface TaskCommandDeps {
  client: () => TaskCommandClient;
  readFile: (path: string) => string;
}

const defaultDeps: TaskCommandDeps = {
  client: () => makeClient(),
  readFile: (path) => readFileSync(path, "utf8"),
};

export const TASK_LIST_COLUMNS = ["name", "category", "status", "schedule", "environment", "id"];
export const TASK_RUN_COLUMNS = ["state", "detail", "trigger", "turns", "started", "ended", "id"];

export const RUN_STATE_WORDS: Record<TaskRun["state"], string> = {
  running: "running",
  waiting: "waiting for you",
  sleeping: "sleeping",
  result_ready: "result ready",
  completed: "done",
  aborted: "aborted",
  failed: "failed",
};

const WAITING_WORDS: Record<NonNullable<TaskRun["waiting_reason"]>, string> = {
  question: "it asked a question",
  approval: "it asks for an approval",
  no_progress: "it made no progress",
  budget: "the monthly AI budget is used up",
  question_expired: "its question expired",
  ai_access: "AI access is missing",
  turn_stopped: "it was stopped and waits for you",
  conversation_abandoned: "its conversation was abandoned",
};

const AUTOMATIC_WAIT_LINES: Partial<Record<NonNullable<TaskRun["waiting_reason"]>, string>> = {
  budget:
    "This run waits for the monthly AI budget and continues on its own once allowance is available",
  ai_access: "This run waits for AI access and continues on its own once a provider is set up",
};

const PAUSED_WORDS: Record<NonNullable<Task["paused_reason"]>, string> = {
  owner_request: "paused",
  admin: "paused by an admin",
  owner_unavailable: "paused, the owner is unavailable",
};

const LIMIT_WORDS: Partial<Record<NonNullable<TaskRun["failure_code"]>, string>> = {
  turn_limit_reached: "it reached its round limit and ended; start the task again",
  deadline_exceeded: "it reached its time limit and ended; start the task again",
};

export function taskCockpitUrl(client: Pick<EngineClient, "base">, taskId: string): string {
  return cockpitUrl(client, `tasks/${encodeURIComponent(taskId)}`);
}

export function taskStatus(task: Task): string {
  if (task.lifecycle === "archived") return "archived";
  if (task.paused_at !== null)
    return task.paused_reason ? PAUSED_WORDS[task.paused_reason] : "paused";
  return "active";
}

export function taskSchedule(task: Task): string {
  if (task.schedule_cron !== null) {
    return `${task.schedule_cron} (${task.schedule_timezone ?? "UTC"})`;
  }
  if (task.schedule_run_at !== null) return `once at ${task.schedule_run_at}`;
  return "by hand";
}

export function taskListRow(task: Task): Record<string, unknown> {
  return {
    name: task.name,
    category: task.category,
    status: taskStatus(task),
    schedule: taskSchedule(task),
    environment: task.environment,
    id: task.id,
  };
}

export function runDetail(run: TaskRun): string {
  if (run.state === "waiting" && run.waiting_reason) return WAITING_WORDS[run.waiting_reason];
  if (run.state === "sleeping" && run.next_check_at) return `next check ${run.next_check_at}`;
  if (run.state === "failed" && run.failure_code)
    return LIMIT_WORDS[run.failure_code] ?? run.failure_code;
  return "";
}

export function taskRunRow(run: TaskRun): Record<string, unknown> {
  return {
    state: RUN_STATE_WORDS[run.state],
    detail: runDetail(run),
    trigger: run.trigger,
    turns: run.turns_used,
    started: run.created_at,
    ended: run.ended_at,
    id: run.id,
  };
}

export function runAttentionLine(
  run: Pick<TaskRun, "state" | "waiting_reason">,
  url: string,
): string | null {
  if (run.state === "waiting") {
    const automaticWait = run.waiting_reason ? AUTOMATIC_WAIT_LINES[run.waiting_reason] : undefined;
    return automaticWait
      ? `${automaticWait}: ${url}`
      : `This run is waiting for you. Answer in the Cockpit: ${url}`;
  }
  if (run.state === "result_ready") {
    return `The result is ready. A person confirms it in the Cockpit: ${url}`;
  }
  return null;
}

export function unrevokedGrant(grants: readonly TaskGrant[]): TaskGrant | null {
  return grants.find((grant) => grant.revoked_at === null) ?? null;
}

export function permissionLine(live: boolean, grant: TaskGrant | null, url: string): string {
  if (!live) {
    return `Standing permission: none. Scheduled runs wait until a person allows them in the Cockpit: ${url}`;
  }
  if (grant === null) return "Standing permission: live";
  const until = grant.valid_until === null ? "until revoked" : `until ${grant.valid_until}`;
  const runs =
    grant.max_runs === null ? "" : `, ${grant.reserved_runs} of ${grant.max_runs} runs used`;
  return `Standing permission: live ${until}${runs}`;
}

function count(amount: number, word: string): string {
  return `${amount} ${word}${amount === 1 ? "" : "s"}`;
}

export function taskDetail(
  task: Task,
  view: Pick<TaskView, "latest_run" | "next_start_at"> | null,
): Record<string, unknown> {
  const { bindings } = task;
  const latest = view?.latest_run ?? null;
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    category: task.category,
    status: taskStatus(task),
    goal: task.goal,
    done_when: task.done_when,
    schedule: taskSchedule(task),
    environment: task.environment,
    may_use: [
      count(bindings.workflow_ids.length, "workflow"),
      count(bindings.connector_ids.length, "connector"),
      count(bindings.skill_slugs.length, "skill"),
      `web search ${bindings.web_search ? "on" : "off"}`,
    ].join(", "),
    plan: count(task.plan.steps.length, "step"),
    limits: `${count(task.max_turns, "turn")}, ${count(task.run_deadline_minutes, "minute")} per run`,
    latest_run: latest ? `${RUN_STATE_WORDS[latest.state]} (${latest.id})` : "none yet",
    ...(view ? { next_start: view.next_start_at ?? "none" } : {}),
    revision: task.revision,
    updated_at: task.updated_at,
  };
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function readTaskFile(
  deps: TaskCommandDeps,
  path: string,
): { definition: TaskDefinition; expected_revision: number | null } {
  const parsed = parseTaskFile(deps.readFile(path));
  if (!parsed.ok) throw new Error(describeTaskFileIssues(path, parsed.issues));
  return parsed;
}

function isScheduled(task: Task): boolean {
  return task.schedule_cron !== null || task.schedule_run_at !== null;
}

const jsonArg = { type: "boolean" as const, description: "JSON output", default: false };

export function buildTasksCommand(overrides: Partial<TaskCommandDeps> = {}) {
  const deps: TaskCommandDeps = { ...defaultDeps, ...overrides };

  const taskListArgs = {
    category: { type: "string", description: "Only this catalog block" },
    archived: { type: "boolean", description: "Show archived tasks instead", default: false },
    limit: { type: "string", description: "Max rows", default: "50" },
    json: jsonArg,
  } as const;

  const listCommand = defineCommand({
    meta: { name: "list", description: "List tasks (your own; an admin sees all)" },
    args: taskListArgs,
    async run({ args }) {
      return withCommandErrors(
        async () => {
          const { items, total } = await deps.client().listTasks({
            lifecycle: args.archived ? "archived" : "active",
            limit: Number(args.limit),
            ...(args.category ? { category: args.category } : {}),
          });
          if (args.json) return printJson(items);
          emitList(false, TASK_LIST_COLUMNS, items.map(taskListRow));
          write(`${total} task${total === 1 ? "" : "s"} total`);
        },
        { json: Boolean(args.json) },
      );
    },
  });

  const getCommand = defineCommand({
    meta: {
      name: "get",
      description: "Show a task, its latest run and whether its standing permission is live",
    },
    args: {
      id: { type: "positional", description: "Task id", required: true },
      json: jsonArg,
    },
    async run({ args }) {
      return withCommandErrors(
        async () => {
          const client = deps.client();
          const id = String(args.id);
          const task = await client.getTask(id);
          const latest = task.latest_run;
          const grant = task.grant_live
            ? unrevokedGrant((await client.listTaskGrants(id)).items)
            : null;
          const url = taskCockpitUrl(client, task.id);
          if (args.json) {
            return printJson({ ...task, standing_permission: grant, cockpit_url: url });
          }
          emitOne(false, taskDetail(task, task));
          write(permissionLine(task.grant_live, grant, url));
          const attention = latest ? runAttentionLine(latest, url) : null;
          if (attention) write(attention);
        },
        { json: Boolean(args.json) },
      );
    },
  });

  const createCommand = defineCommand({
    meta: {
      name: "create",
      description:
        "Create a task from a JSON file (--file); it belongs to you and starts by hand until a person allows scheduled runs in the Cockpit",
    },
    args: {
      file: { type: "string", description: "Path to the task JSON file", required: true },
      json: jsonArg,
    },
    async run({ args }) {
      return withCommandErrors(
        async () => {
          const client = deps.client();
          const { definition } = readTaskFile(deps, String(args.file));
          const task = await client.createTask(definition);
          if (args.json) return printJson(task);
          emitOne(false, taskDetail(task, null));
          if (isScheduled(task)) {
            write(permissionLine(false, null, taskCockpitUrl(client, task.id)));
          }
        },
        { json: Boolean(args.json) },
      );
    },
  });

  const updateCommand = defineCommand({
    meta: {
      name: "update",
      description:
        "Replace a task from a JSON file (--file) or change only its schedule (--cron with --timezone, or --run-at); a content change stops the open run and ends the standing permission",
    },
    args: {
      id: { type: "positional", description: "Task id", required: true },
      file: { type: "string", description: "Path to the task JSON file" },
      cron: { type: "string", description: 'New 5-field cron (e.g. "0 8 * * 1-5")' },
      timezone: { type: "string", description: "New IANA timezone (default UTC)" },
      "run-at": {
        type: "string",
        description: "Run once at this ISO instant (e.g. 2026-12-01T07:00:00+01:00)",
      },
      json: jsonArg,
    },
    async run({ args }) {
      return withCommandErrors(
        async () => {
          const client = deps.client();
          const id = String(args.id);
          const flags = { cron: args.cron, timezone: args.timezone, runAt: args["run-at"] };
          const hasFlags = Object.values(flags).some((value) => value !== undefined);
          let definition: TaskDefinition;
          let revision: number;
          if (args.file !== undefined) {
            if (hasFlags) {
              throw new Error(
                "pass either --file or schedule flags (--cron, --timezone, --run-at), not both",
              );
            }
            const file = readTaskFile(deps, args.file);
            definition = file.definition;
            revision = file.expected_revision ?? (await client.getTask(id)).revision;
          } else {
            const task = await client.getTask(id);
            const current = taskDefinitionOf(task);
            const change = scheduleFromFlags(flags, current);
            if (!change.ok) throw new Error(describeFlagIssues(change.issues));
            definition = { ...current, ...change.schedule };
            revision = task.revision;
          }
          const updated = await client.updateTask(id, taskUpdateBody(definition, revision));
          if (args.json) return printJson(updated);
          const { schedule_changed, grant_invalidated, aborted_run_id, ...task } = updated;
          emitOne(false, taskDetail(task, null));
          if (schedule_changed) write(`Schedule is now: ${taskSchedule(task)}`);
          if (aborted_run_id) {
            write(`The open run ${aborted_run_id} was stopped because the task changed.`);
          }
          if (grant_invalidated) {
            write(
              `The standing permission ended with this change. A person can allow it again in the Cockpit: ${taskCockpitUrl(client, task.id)}`,
            );
          }
        },
        { json: Boolean(args.json) },
      );
    },
  });

  const runCommand = defineCommand({
    meta: {
      name: "run",
      description: "Start a task now, as you; the run works in its own conversation",
    },
    args: {
      id: { type: "positional", description: "Task id", required: true },
      json: jsonArg,
    },
    async run({ args }) {
      return withCommandErrors(
        async () => {
          const client = deps.client();
          const run = await client.startTaskRun(String(args.id));
          if (args.json) return printJson(run);
          write(`started run ${run.id} (${RUN_STATE_WORDS[run.state]})`);
          write(`Follow it with: subkit tasks runs ${run.task_id}`);
          const attention = runAttentionLine(run, taskCockpitUrl(client, run.task_id));
          if (attention) write(attention);
        },
        { json: Boolean(args.json) },
      );
    },
  });

  const runsCommand = defineCommand({
    meta: { name: "runs", description: "List the runs of a task, newest first" },
    args: {
      id: { type: "positional", description: "Task id", required: true },
      limit: { type: "string", description: "Max rows", default: "20" },
      json: jsonArg,
    },
    async run({ args }) {
      return withCommandErrors(
        async () => {
          const client = deps.client();
          const id = String(args.id);
          const { items, total } = await client.listTaskRuns(id, { limit: Number(args.limit) });
          if (args.json) return printJson(items);
          emitList(false, TASK_RUN_COLUMNS, items.map(taskRunRow));
          write(`${total} run${total === 1 ? "" : "s"} total`);
          const url = taskCockpitUrl(client, id);
          const attention = items
            .map((run) => runAttentionLine(run, url))
            .find((line) => line !== null);
          if (attention) write(attention);
        },
        { json: Boolean(args.json) },
      );
    },
  });

  const pauseCommand = defineCommand({
    meta: {
      name: "pause",
      description: "Pause a task: no run starts and an open run sleeps until you resume it",
    },
    args: {
      id: { type: "positional", description: "Task id", required: true },
      json: jsonArg,
    },
    async run({ args }) {
      return withCommandErrors(
        async () => {
          const task = await deps.client().pauseTask(String(args.id));
          if (args.json) return printJson(task);
          write(`paused ${task.name} (${task.id})`);
        },
        { json: Boolean(args.json) },
      );
    },
  });

  const resumeCommand = defineCommand({
    meta: {
      name: "resume",
      description: "Resume a paused task; a run that slept through the pause continues",
    },
    args: {
      id: { type: "positional", description: "Task id", required: true },
      json: jsonArg,
    },
    async run({ args }) {
      return withCommandErrors(
        async () => {
          const client = deps.client();
          const resumed = await client.resumeTask(String(args.id));
          if (args.json) return printJson(resumed);
          write(`resumed ${resumed.name} (${resumed.id})`);
          if (!resumed.run) return;
          write(`run ${resumed.run.id} is ${RUN_STATE_WORDS[resumed.run.state]}`);
          const attention = runAttentionLine(resumed.run, taskCockpitUrl(client, resumed.id));
          if (attention) write(attention);
        },
        { json: Boolean(args.json) },
      );
    },
  });

  const abortCommand = defineCommand({
    meta: { name: "abort", description: "Stop a run that is running, waiting or sleeping" },
    args: {
      id: {
        type: "positional",
        description: "Run id (see `subkit tasks runs <id>`)",
        required: true,
      },
      json: jsonArg,
    },
    async run({ args }) {
      return withCommandErrors(
        async () => {
          const run = await deps.client().abortTaskRun(String(args.id));
          if (args.json) return printJson(run);
          write(`run ${run.id} is ${RUN_STATE_WORDS[run.state]}`);
        },
        { json: Boolean(args.json) },
      );
    },
  });

  const deleteCommand = defineCommand({
    meta: {
      name: "delete",
      description:
        "Delete a task: it is archived, its open run stops and its standing permission ends",
    },
    args: {
      id: { type: "positional", description: "Task id", required: true },
      json: jsonArg,
    },
    async run({ args }) {
      return withCommandErrors(
        async () => {
          const out = await deps.client().deleteTask(String(args.id));
          if (args.json) return printJson(out);
          write(`deleted ${out.id}`);
        },
        { json: Boolean(args.json) },
      );
    },
  });

  return defineCommand({
    meta: {
      name: "tasks",
      description: "Tasks: a goal with limits that works on its own and asks before it acts",
    },
    args: taskListArgs,
    subCommands: {
      list: listCommand,
      get: getCommand,
      create: createCommand,
      update: updateCommand,
      run: runCommand,
      runs: runsCommand,
      pause: pauseCommand,
      resume: resumeCommand,
      abort: abortCommand,
      delete: deleteCommand,
    },
    default: "list",
  });
}

export const tasksCommand = buildTasksCommand();
