import { afterEach, beforeEach } from "bun:test";
import { runCommand } from "citty";
import type { Task, TaskGrant, TaskLatestRun, TaskRun, TaskView } from "../engine-client/tasks.ts";
import { buildTasksCommand, type TaskCommandClient } from "./tasks.ts";

export const TASK_ID = "10000000-0000-4000-8000-000000000001";
export const RUN_ID = "10000000-0000-4000-8000-000000000002";
export const GRANT_ID = "10000000-0000-4000-8000-000000000003";
export const OWNER_ID = "10000000-0000-4000-8000-000000000004";
export const NOW = new Date("2026-11-19T10:00:00.000Z");
export const TASK_URL = `https://engine.test/gateway/cockpit/tasks/${TASK_ID}`;

export const definition = {
  name: "Chase invoices",
  goal: "Remind customers of open invoices",
  done_when: "Every open invoice has a reminder",
  plan: {
    title: "Chase invoices",
    goal: "Remind customers of open invoices",
    steps: [
      {
        id: "confirm-result",
        label: "Confirm the result",
        criterion: {
          kind: "human_confirmation" as const,
          question: "Is this done: Remind customers of open invoices?",
        },
        depends_on: [],
        evidence_ids: [],
        note: null,
        progress: "open" as const,
        next_action: null,
      },
    ],
    cancelled: false,
    completion_step_id: "confirm-result",
  },
  bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
  environment: "prod" as const,
};

export function latestRun(run: TaskRun): TaskLatestRun {
  return {
    id: run.id,
    state: run.state,
    waiting_reason: run.waiting_reason,
    next_check_at: run.next_check_at,
    started_at: run.created_at,
    ended_at: run.ended_at,
    conversation_id: run.conversation_id,
  };
}

export function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    ...definition,
    id: TASK_ID,
    description: null,
    category: "finance",
    owner_id: OWNER_ID,
    schedule_cron: null,
    schedule_timezone: null,
    schedule_run_at: null,
    last_claimed_at: null,
    paused_at: null,
    paused_by: null,
    paused_reason: null,
    max_turns: 20,
    run_deadline_minutes: 240,
    fingerprint: "a".repeat(64),
    revision: 3,
    lifecycle: "active",
    source_conversation_id: null,
    source_message_id: null,
    created_at: "2026-11-01T08:00:00.000Z",
    updated_at: "2026-11-02T08:00:00.000Z",
    latest_run: null,
    grant_live: false,
    next_start_at: null,
    ...overrides,
  };
}

export function taskRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: RUN_ID,
    task_id: TASK_ID,
    task_revision: 3,
    fingerprint: "a".repeat(64),
    conversation_id: null,
    trigger: "manual",
    started_by: OWNER_ID,
    grant_id: null,
    state: "running",
    waiting_reason: null,
    next_check_at: null,
    sleep_reason: null,
    deadline_at: "2026-11-19T14:00:00.000Z",
    turns_used: 2,
    no_progress_count: 0,
    last_seen_turn_id: null,
    last_playbook_revision: 1,
    trace_id: "b".repeat(32),
    failure_code: null,
    result_ready_at: null,
    completed_at: null,
    completed_by: null,
    ended_at: null,
    created_at: "2026-11-19T09:00:00.000Z",
    updated_at: "2026-11-19T09:30:00.000Z",
    ...overrides,
  };
}

export function grant(overrides: Partial<TaskGrant> = {}): TaskGrant {
  return {
    id: GRANT_ID,
    task_id: TASK_ID,
    fingerprint: "a".repeat(64),
    environment: "prod",
    valid_from: "2026-11-01T08:00:00.000Z",
    valid_until: null,
    max_runs: null,
    reserved_runs: 0,
    created_by: OWNER_ID,
    created_at: "2026-11-01T08:00:00.000Z",
    revoked_at: null,
    revoked_by: null,
    workflow_authority_ids: [],
    ...overrides,
  };
}

type Call = [method: string, ...args: unknown[]];

export interface World {
  task: TaskView;
  runs: TaskRun[];
  grants: TaskGrant[];
  files: Record<string, string>;
  update: { schedule_changed: boolean; grant_invalidated: boolean; aborted_run_id: string | null };
  resumedRun: TaskRun | null;
  startError: Error | null;
}

export const state: {
  world: World;
  calls: Call[];
  stdout: string;
  stderr: string;
} = { world: freshWorld(), calls: [], stdout: "", stderr: "" };

let previousOut: typeof process.stdout.write;
let previousErr: typeof process.stderr.write;

function freshWorld(): World {
  return {
    task: task(),
    runs: [],
    grants: [],
    files: { "task.json": JSON.stringify(definition) },
    update: { schedule_changed: false, grant_invalidated: false, aborted_run_id: null },
    resumedRun: null,
    startError: null,
  };
}

function fakeClient(): TaskCommandClient {
  return {
    base: "https://engine.test/gateway",
    async listTasks(query) {
      state.calls.push(["listTasks", query]);
      return { items: [state.world.task], total: 1 };
    },
    async getTask(id) {
      state.calls.push(["getTask", id]);
      return state.world.task;
    },
    async createTask(body) {
      state.calls.push(["createTask", body]);
      return { ...state.world.task, ...body } as Task;
    },
    async updateTask(id, body) {
      state.calls.push(["updateTask", id, body]);
      const { expected_revision, ...rest } = body;
      return {
        ...state.world.task,
        ...rest,
        revision: expected_revision + 1,
        ...state.world.update,
      } as never;
    },
    async deleteTask(id) {
      state.calls.push(["deleteTask", id]);
      return { id, deleted: true as const };
    },
    async pauseTask(id) {
      state.calls.push(["pauseTask", id]);
      return { ...state.world.task, paused_at: NOW.toISOString(), paused_reason: "owner_request" };
    },
    async resumeTask(id) {
      state.calls.push(["resumeTask", id]);
      return { ...state.world.task, run: state.world.resumedRun };
    },
    async startTaskRun(id) {
      state.calls.push(["startTaskRun", id]);
      if (state.world.startError) throw state.world.startError;
      return state.world.runs[0] ?? taskRun();
    },
    async listTaskRuns(id, query) {
      state.calls.push(["listTaskRuns", id, query]);
      return { items: state.world.runs, total: state.world.runs.length };
    },
    async abortTaskRun(id) {
      state.calls.push(["abortTaskRun", id]);
      return taskRun({ id, state: "aborted", ended_at: NOW.toISOString() });
    },
    async listTaskGrants(id) {
      state.calls.push(["listTaskGrants", id]);
      return { items: state.world.grants };
    },
  };
}

export async function subkit(...rawArgs: string[]): Promise<unknown> {
  const command = buildTasksCommand({
    client: fakeClient,
    readFile: (path) => {
      const content = state.world.files[path];
      if (content === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return content;
    },
  });
  try {
    await runCommand(command, { rawArgs });
    return undefined;
  } catch (error) {
    return error;
  }
}

export function installTaskHarness(): void {
  beforeEach(() => {
    state.world = freshWorld();
    state.calls = [];
    state.stdout = "";
    state.stderr = "";
    previousOut = process.stdout.write.bind(process.stdout);
    previousErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      state.stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      state.stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = previousOut;
    process.stderr.write = previousErr;
  });
}
