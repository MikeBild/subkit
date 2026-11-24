import { describe, expect, test } from "bun:test";
import { SUB_COMMANDS } from "../index.ts";
import {
  GRANT_ID,
  grant,
  installTaskHarness,
  latestRun,
  NOW,
  RUN_ID,
  state,
  subkit,
  TASK_ID,
  TASK_URL,
  task,
  taskRun,
} from "./task-test-fixtures.ts";
import {
  permissionLine,
  RUN_STATE_WORDS,
  runAttentionLine,
  runDetail,
  TASK_LIST_COLUMNS,
  taskSchedule,
  taskStatus,
  tasksCommand,
  unrevokedGrant,
} from "./tasks.ts";

installTaskHarness();

describe("subkit tasks command surface", () => {
  test("registers its ten verbs and offers no confirm or reject, gated by task:read", () => {
    const command = tasksCommand as unknown as { subCommands: Record<string, unknown> };
    expect(Object.keys(command.subCommands).sort()).toEqual([
      "abort",
      "create",
      "delete",
      "get",
      "list",
      "pause",
      "resume",
      "run",
      "runs",
      "update",
    ]);
    expect(SUB_COMMANDS.tasks?.command).toBe(tasksCommand);
    expect(SUB_COMMANDS.tasks?.requires).toBe("task:read");
  });

  test("the bare group lists tasks", async () => {
    await subkit();
    expect(state.calls).toEqual([["listTasks", { lifecycle: "active", limit: 50 }]]);
  });
});

describe("subkit tasks words", () => {
  test("every run state has an English word", () => {
    expect(RUN_STATE_WORDS).toEqual({
      running: "running",
      waiting: "waiting for you",
      sleeping: "sleeping",
      result_ready: "result ready",
      completed: "done",
      aborted: "aborted",
      failed: "failed",
    });
  });

  test("task status follows lifecycle and pause reason", () => {
    expect(taskStatus(task())).toBe("active");
    expect(taskStatus(task({ lifecycle: "archived", paused_at: NOW.toISOString() }))).toBe(
      "archived",
    );
    expect(taskStatus(task({ paused_at: NOW.toISOString() }))).toBe("paused");
    expect(taskStatus(task({ paused_at: NOW.toISOString(), paused_reason: "owner_request" }))).toBe(
      "paused",
    );
    expect(taskStatus(task({ paused_at: NOW.toISOString(), paused_reason: "admin" }))).toBe(
      "paused by an admin",
    );
    expect(
      taskStatus(task({ paused_at: NOW.toISOString(), paused_reason: "owner_unavailable" })),
    ).toBe("paused, the owner is unavailable");
  });

  test("the schedule reads as cron with timezone, a single time or by hand", () => {
    expect(taskSchedule(task())).toBe("by hand");
    expect(taskSchedule(task({ schedule_cron: "0 7 * * *" }))).toBe("0 7 * * * (UTC)");
    expect(
      taskSchedule(task({ schedule_cron: "0 7 * * *", schedule_timezone: "Europe/Berlin" })),
    ).toBe("0 7 * * * (Europe/Berlin)");
    expect(taskSchedule(task({ schedule_run_at: "2026-12-01T06:00:00.000Z" }))).toBe(
      "once at 2026-12-01T06:00:00.000Z",
    );
  });

  test("the run detail explains waiting, sleeping and failed runs", () => {
    expect(runDetail(taskRun())).toBe("");
    expect(runDetail(taskRun({ state: "waiting" }))).toBe("");
    expect(runDetail(taskRun({ state: "waiting", waiting_reason: "approval" }))).toBe(
      "it asks for an approval",
    );
    expect(runDetail(taskRun({ state: "waiting", waiting_reason: "budget" }))).toBe(
      "the monthly AI budget is used up",
    );
    expect(runDetail(taskRun({ state: "sleeping" }))).toBe("");
    expect(
      runDetail(taskRun({ state: "sleeping", next_check_at: "2026-11-19T14:30:00.000Z" })),
    ).toBe("next check 2026-11-19T14:30:00.000Z");
    expect(runDetail(taskRun({ state: "failed" }))).toBe("");
    expect(runDetail(taskRun({ state: "failed", failure_code: "deadline_exceeded" }))).toBe(
      "it reached its time limit and ended; start the task again",
    );
    expect(runDetail(taskRun({ state: "failed", failure_code: "turn_limit_reached" }))).toBe(
      "it reached its round limit and ended; start the task again",
    );
    expect(runDetail(taskRun({ state: "failed", failure_code: "turn_failed" }))).toBe(
      "turn_failed",
    );
  });

  test("only waiting and result-ready runs point a person to the Cockpit", () => {
    expect(runAttentionLine(taskRun({ state: "waiting" }), TASK_URL)).toBe(
      `This run is waiting for you. Answer in the Cockpit: ${TASK_URL}`,
    );
    expect(runAttentionLine(taskRun({ state: "result_ready" }), TASK_URL)).toBe(
      `The result is ready. A person confirms it in the Cockpit: ${TASK_URL}`,
    );
    for (const state of ["running", "sleeping", "completed", "aborted", "failed"] as const) {
      expect(runAttentionLine(taskRun({ state }), TASK_URL)).toBeNull();
    }
  });
});

describe("standing permission", () => {
  test("the grant shown is the one that is not revoked; whether it is live is the server's word", () => {
    expect(unrevokedGrant([grant({ revoked_at: "2026-11-18T08:00:00.000Z" }), grant()])?.id).toBe(
      GRANT_ID,
    );
    expect(unrevokedGrant([grant({ revoked_at: "2026-11-18T08:00:00.000Z" })])).toBeNull();
    expect(unrevokedGrant([])).toBeNull();
  });

  test("the line names validity and used runs, or the Cockpit page when none is live", () => {
    expect(permissionLine(true, grant(), TASK_URL)).toBe("Standing permission: live until revoked");
    expect(
      permissionLine(
        true,
        grant({ valid_until: "2026-12-01T00:00:00.000Z", max_runs: 5, reserved_runs: 2 }),
        TASK_URL,
      ),
    ).toBe("Standing permission: live until 2026-12-01T00:00:00.000Z, 2 of 5 runs used");
    expect(permissionLine(true, null, TASK_URL)).toBe("Standing permission: live");
    const none = `Standing permission: none. Scheduled runs wait until a person allows them in the Cockpit: ${TASK_URL}`;
    expect(permissionLine(false, null, TASK_URL)).toBe(none);
    expect(permissionLine(false, grant(), TASK_URL)).toBe(none);
  });
});

describe("subkit tasks list and get", () => {
  test("list prints the table and the total", async () => {
    await subkit("list", "--category", "finance", "--limit", "5");
    expect(state.calls).toEqual([
      ["listTasks", { lifecycle: "active", limit: 5, category: "finance" }],
    ]);
    expect(TASK_LIST_COLUMNS).toEqual([
      "name",
      "category",
      "status",
      "schedule",
      "environment",
      "id",
    ]);
    expect(state.stdout).toContain("Chase invoices");
    expect(state.stdout).toContain("by hand");
    expect(state.stdout).toContain(TASK_ID);
    expect(state.stdout).toEndWith("1 task total\n");
  });

  test("list --archived --json prints the raw tasks", async () => {
    state.world.task = task({ lifecycle: "archived" });
    await subkit("list", "--archived", "--json");
    expect(state.calls).toEqual([["listTasks", { lifecycle: "archived", limit: 50 }]]);
    expect(JSON.parse(state.stdout)).toEqual([state.world.task]);
  });

  test("bare tasks lists once with the list defaults", async () => {
    await subkit();
    expect(state.calls).toEqual([["listTasks", { lifecycle: "active", limit: 50 }]]);
    expect(state.stdout).toEndWith("1 task total\n");
  });

  test("bare tasks forwards list flags and emits a single JSON document", async () => {
    await subkit("--json", "--limit", "5");
    expect(state.calls).toEqual([["listTasks", { lifecycle: "active", limit: 5 }]]);
    expect(JSON.parse(state.stdout)).toEqual([state.world.task]);
  });

  test("get --json runs only the subcommand, never the parent list", async () => {
    await subkit("get", TASK_ID, "--json");
    expect(state.calls.map(([method]) => method)).toEqual(["getTask"]);
    expect(JSON.parse(state.stdout)).toMatchObject({ id: TASK_ID });
  });

  test("get shows the task, no run yet and where a person can allow it", async () => {
    await subkit("get", TASK_ID);
    expect(state.calls).toEqual([["getTask", TASK_ID]]);
    expect(state.stdout).toContain("Remind customers of open invoices");
    expect(state.stdout).toMatch(/may_use\s+0 workflows, 0 connectors, 0 skills, web search off/);
    expect(state.stdout).toMatch(/plan\s+1 step\n/);
    expect(state.stdout).toMatch(/limits\s+20 turns, 240 minutes per run/);
    expect(state.stdout).toMatch(/latest_run\s+none yet/);
    expect(state.stdout).toMatch(/next_start\s+none/);
    expect(state.stdout).toEndWith(
      `Standing permission: none. Scheduled runs wait until a person allows them in the Cockpit: ${TASK_URL}\n`,
    );
  });

  test("get shows a live permission and the waiting run with the Cockpit address", async () => {
    state.world.task = task({
      bindings: {
        workflow_ids: [RUN_ID],
        connector_ids: [GRANT_ID],
        skill_slugs: ["tone"],
        web_search: true,
      },
      latest_run: latestRun(taskRun({ state: "waiting", waiting_reason: "question" })),
      grant_live: true,
      next_start_at: "2026-11-20T07:00:00.000Z",
    });
    state.world.grants = [grant()];
    await subkit("get", TASK_ID);
    expect(state.calls).toEqual([
      ["getTask", TASK_ID],
      ["listTaskGrants", TASK_ID],
    ]);
    expect(state.stdout).toMatch(/next_start\s+2026-11-20T07:00:00.000Z/);
    expect(state.stdout).toMatch(/may_use\s+1 workflow, 1 connector, 1 skill, web search on/);
    expect(state.stdout).toMatch(new RegExp(`latest_run\\s+waiting for you \\(${RUN_ID}\\)`));
    expect(state.stdout).toEndWith(
      `Standing permission: live until revoked\nThis run is waiting for you. Answer in the Cockpit: ${TASK_URL}\n`,
    );
  });

  test("get --json prints the server's view and adds the live permission and the Cockpit address", async () => {
    state.world.task = task({
      latest_run: latestRun(taskRun({ state: "result_ready" })),
      grant_live: true,
      next_start_at: "2026-11-20T07:00:00.000Z",
    });
    state.world.grants = [grant()];
    await subkit("get", TASK_ID, "--json");
    expect(JSON.parse(state.stdout)).toEqual({
      ...state.world.task,
      standing_permission: state.world.grants[0],
      cockpit_url: TASK_URL,
    });
  });

  test("a permission the server no longer counts as live is not shown, whatever the grant list says", async () => {
    state.world.task = task({ grant_live: false });
    state.world.grants = [grant()];
    await subkit("get", TASK_ID, "--json");
    expect(state.calls).toEqual([["getTask", TASK_ID]]);
    expect(JSON.parse(state.stdout)).toMatchObject({
      grant_live: false,
      standing_permission: null,
    });
  });
});
