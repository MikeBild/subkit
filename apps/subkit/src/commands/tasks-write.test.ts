import { describe, expect, test } from "bun:test";
import { EngineError } from "@cli-core/errors";
import { EngineClient } from "../engine-client.ts";
import {
  definition,
  GRANT_ID,
  installTaskHarness,
  OWNER_ID,
  RUN_ID,
  state,
  subkit,
  TASK_ID,
  TASK_URL,
  task,
  taskRun,
} from "./task-test-fixtures.ts";
import { TASK_RUN_COLUMNS } from "./tasks.ts";

installTaskHarness();

describe("subkit tasks create and update", () => {
  test("create sends the file's definition and prints the task", async () => {
    await subkit("create", "--file", "task.json");
    expect(state.calls).toEqual([["createTask", definition]]);
    expect(state.stdout).toContain("Chase invoices");
    expect(state.stdout).not.toContain("Standing permission");
  });

  test("create of a scheduled task says where a person can allow it", async () => {
    state.world.files["task.json"] = JSON.stringify({ ...definition, schedule_cron: "0 7 * * *" });
    await subkit("create", "--file", "task.json");
    expect(state.stdout).toEndWith(
      `Standing permission: none. Scheduled runs wait until a person allows them in the Cockpit: ${TASK_URL}\n`,
    );
  });

  test("create --json prints the created task", async () => {
    state.world.files["task.json"] = JSON.stringify({
      ...definition,
      schedule_run_at: "2026-12-01T06:00:00Z",
    });
    await subkit("create", "--file", "task.json", "--json");
    expect(JSON.parse(state.stdout).schedule_run_at).toBe("2026-12-01T06:00:00Z");
  });

  test("an invalid file names the field and the fix and sends nothing", async () => {
    state.world.files["task.json"] = JSON.stringify({ ...definition, environment: "stage" });
    const error = await subkit("create", "--file", "task.json");
    expect(error).toBeInstanceOf(Error);
    expect(state.calls).toEqual([]);
    expect(state.stderr).toContain("task.json is not a valid task file:");
    expect(state.stderr).toContain(
      'environment must be "dev" or "prod"; set "environment" to "dev" or "prod"',
    );
  });

  test("a missing file is reported", async () => {
    const error = await subkit("create", "--file", "missing.json");
    expect(error).toBeInstanceOf(Error);
    expect(state.stderr).toContain("missing.json");
  });

  test("update --file reads the current revision when the file has none", async () => {
    await subkit("update", TASK_ID, "--file", "task.json");
    expect(state.calls).toEqual([
      ["getTask", TASK_ID],
      ["updateTask", TASK_ID, { ...definition, expected_revision: 3 }],
    ]);
    expect(state.stdout).toContain("Chase invoices");
    expect(state.stdout).not.toContain("Schedule is now");
  });

  test("update --file with a revision does not read the task first", async () => {
    state.world.files["task.json"] = JSON.stringify({ ...definition, revision: 2 });
    await subkit("update", TASK_ID, "--file", "task.json", "--json");
    expect(state.calls).toEqual([["updateTask", TASK_ID, { ...definition, expected_revision: 2 }]]);
    expect(JSON.parse(state.stdout).revision).toBe(3);
  });

  test("update --cron --timezone changes only the schedule", async () => {
    state.world.update = {
      schedule_changed: true,
      grant_invalidated: true,
      aborted_run_id: RUN_ID,
    };
    await subkit("update", TASK_ID, "--cron", "0 8 * * 1-5", "--timezone", "Europe/Berlin");
    expect(state.calls[1]).toEqual([
      "updateTask",
      TASK_ID,
      {
        ...definition,
        description: null,
        category: "finance",
        schedule_cron: "0 8 * * 1-5",
        schedule_timezone: "Europe/Berlin",
        schedule_run_at: null,
        max_turns: 20,
        run_deadline_minutes: 240,
        expected_revision: 3,
      },
    ]);
    expect(state.stdout).toContain("Schedule is now: 0 8 * * 1-5 (Europe/Berlin)\n");
    expect(state.stdout).toContain(
      `The open run ${RUN_ID} was stopped because the task changed.\n`,
    );
    expect(state.stdout).toEndWith(
      `The standing permission ended with this change. A person can allow it again in the Cockpit: ${TASK_URL}\n`,
    );
  });

  test("update --run-at replaces a cron schedule", async () => {
    state.world.task = task({ schedule_cron: "0 7 * * *", schedule_timezone: "UTC" });
    await subkit("update", TASK_ID, "--run-at", "2026-12-01T07:00:00+01:00");
    expect(state.calls[1]?.[2]).toMatchObject({
      schedule_cron: null,
      schedule_timezone: null,
      schedule_run_at: "2026-12-01T07:00:00+01:00",
    });
  });

  test("update refuses a bad flag, no flag, and a file together with flags", async () => {
    await subkit("update", TASK_ID, "--run-at", "tomorrow");
    expect(state.stderr).toContain("--run-at is not a full date and time with offset");
    await subkit("update", TASK_ID);
    expect(state.stderr).toContain("pass --file <path>, --cron <expr> or --run-at <iso>");
    await subkit("update", TASK_ID, "--file", "task.json", "--cron", "0 8 * * *");
    expect(state.stderr).toContain("pass either --file or schedule flags");
    expect(state.calls.some(([method]) => method === "updateTask")).toBe(false);
  });
});

describe("subkit tasks runs and lifecycle", () => {
  test("run starts the task and says how to follow it", async () => {
    await subkit("run", TASK_ID);
    expect(state.calls).toEqual([["startTaskRun", TASK_ID]]);
    expect(state.stdout).toBe(
      `started run ${RUN_ID} (running)\nFollow it with: subkit tasks runs ${TASK_ID}\n`,
    );
  });

  test("run prints the Cockpit address when the run already waits for a person", async () => {
    state.world.runs = [taskRun({ state: "waiting", waiting_reason: "approval" })];
    await subkit("run", TASK_ID);
    expect(state.stdout).toEndWith(
      `This run is waiting for you. Answer in the Cockpit: ${TASK_URL}\n`,
    );
  });

  test("run --json prints the run", async () => {
    await subkit("run", TASK_ID, "--json");
    expect(JSON.parse(state.stdout)).toEqual(taskRun());
  });

  test("a refused start reports the engine's reason code", async () => {
    state.world.startError = new EngineError(409, {
      code: "previous_run_active",
      message: "The previous run is still open.",
    });
    const error = await subkit("run", TASK_ID);
    expect(error).toBe(state.world.startError);
    expect(state.stderr).toContain("previous_run_active: The previous run is still open.");
  });

  test("runs lists newest first with state words and one Cockpit line", async () => {
    state.world.runs = [
      taskRun({ state: "result_ready" }),
      taskRun({ id: GRANT_ID, state: "waiting", waiting_reason: "question" }),
      taskRun({ id: OWNER_ID, state: "completed", ended_at: "2026-11-18T09:00:00.000Z" }),
    ];
    await subkit("runs", TASK_ID, "--limit", "3");
    expect(state.calls).toEqual([["listTaskRuns", TASK_ID, { limit: 3 }]]);
    expect(TASK_RUN_COLUMNS).toEqual([
      "state",
      "detail",
      "trigger",
      "turns",
      "started",
      "ended",
      "id",
    ]);
    expect(state.stdout).toContain("result ready");
    expect(state.stdout).toContain("waiting for you");
    expect(state.stdout).toContain("it asked a question");
    expect(state.stdout).toContain("done");
    expect(state.stdout).toEndWith(
      `3 runs total\nThe result is ready. A person confirms it in the Cockpit: ${TASK_URL}\n`,
    );
  });

  test("runs without open decisions prints no Cockpit line, and --json the raw runs", async () => {
    state.world.runs = [taskRun({ state: "completed" })];
    await subkit("runs", TASK_ID);
    expect(state.stdout).toEndWith("1 run total\n");
    state.stdout = "";
    await subkit("runs", TASK_ID, "--json");
    expect(JSON.parse(state.stdout)).toEqual(state.world.runs);
  });

  test("pause and resume name the task", async () => {
    await subkit("pause", TASK_ID);
    expect(state.stdout).toBe(`paused Chase invoices (${TASK_ID})\n`);
    state.stdout = "";
    await subkit("resume", TASK_ID);
    expect(state.stdout).toBe(`resumed Chase invoices (${TASK_ID})\n`);
    expect(state.calls).toEqual([
      ["pauseTask", TASK_ID],
      ["resumeTask", TASK_ID],
    ]);
  });

  test("resume reports the run that continues and its open decision", async () => {
    state.world.resumedRun = taskRun({ state: "result_ready" });
    await subkit("resume", TASK_ID);
    expect(state.stdout).toBe(
      [
        `resumed Chase invoices (${TASK_ID})`,
        `run ${RUN_ID} is result ready`,
        `The result is ready. A person confirms it in the Cockpit: ${TASK_URL}`,
        "",
      ].join("\n"),
    );
  });

  test("pause, resume, abort and delete print the engine's answer with --json", async () => {
    await subkit("pause", TASK_ID, "--json");
    expect(JSON.parse(state.stdout).paused_reason).toBe("owner_request");
    state.stdout = "";
    await subkit("resume", TASK_ID, "--json");
    expect(JSON.parse(state.stdout).run).toBeNull();
    state.stdout = "";
    await subkit("abort", RUN_ID, "--json");
    expect(JSON.parse(state.stdout).state).toBe("aborted");
    state.stdout = "";
    await subkit("delete", TASK_ID, "--json");
    expect(JSON.parse(state.stdout)).toEqual({ id: TASK_ID, deleted: true });
  });

  test("abort takes a run id and delete a task id", async () => {
    await subkit("abort", RUN_ID);
    await subkit("delete", TASK_ID);
    expect(state.calls).toEqual([
      ["abortTaskRun", RUN_ID],
      ["deleteTask", TASK_ID],
    ]);
    expect(state.stdout).toBe(`run ${RUN_ID} is aborted\ndeleted ${TASK_ID}\n`);
  });
});

describe("engine client task routes", () => {
  test("every method state.calls its route", async () => {
    const seen: string[] = [];
    const client = new EngineClient({
      engine_url: "https://engine.test",
      api_key: "test-key",
      fetchImpl: async (input, init) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        seen.push(`${method} ${url.pathname}${url.search}`);
        return Response.json({ items: [], total: 0 });
      },
    });
    await client.listTasks({ lifecycle: "active", limit: 5 });
    await client.getTask(TASK_ID);
    await client.createTask(definition);
    await client.updateTask(TASK_ID, { ...definition, expected_revision: 1 });
    await client.deleteTask(TASK_ID);
    await client.pauseTask(TASK_ID);
    await client.resumeTask(TASK_ID);
    await client.startTaskRun(TASK_ID);
    await client.listTaskRuns(TASK_ID, { limit: 1 });
    await client.listTaskRuns(TASK_ID);
    await client.getTaskRun(RUN_ID);
    await client.abortTaskRun(RUN_ID);
    await client.listTaskGrants(TASK_ID);
    await client.listTasks();
    expect(seen).toEqual([
      "GET /v1/tasks?lifecycle=active&limit=5",
      `GET /v1/tasks/${TASK_ID}`,
      "POST /v1/tasks",
      `PUT /v1/tasks/${TASK_ID}`,
      `DELETE /v1/tasks/${TASK_ID}`,
      `POST /v1/tasks/${TASK_ID}/pause`,
      `POST /v1/tasks/${TASK_ID}/resume`,
      `POST /v1/tasks/${TASK_ID}/runs`,
      `GET /v1/tasks/${TASK_ID}/runs?limit=1`,
      `GET /v1/tasks/${TASK_ID}/runs`,
      `GET /v1/task-runs/${RUN_ID}`,
      `POST /v1/task-runs/${RUN_ID}/abort`,
      `GET /v1/tasks/${TASK_ID}/grants`,
      "GET /v1/tasks",
    ]);
  });
});
