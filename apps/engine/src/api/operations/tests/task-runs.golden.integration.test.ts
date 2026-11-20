import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTaskRunTool } from "../../../conversations/tools/engine-api/tasks.ts";
import {
  abortTaskRunTool,
  runTaskTool,
} from "../../../conversations/tools/engine-api/writes/tasks.ts";
import { conversationElicitations } from "../../../db/schema/index.ts";
import { defaultTaskServiceDeps, recordRunObservation } from "../../../tasks/index.ts";
import { createTaskWorld, MISSING, type TaskWorld, taskBody } from "./task-golden-world.ts";

let world: TaskWorld;
let ownerBrowser: Record<string, string>;
let otherBrowser: Record<string, string>;
let ownTask: string;
let foreignTask: string;
let firstRun: string;
let secondRun: string;
let turn = 0;

function idOf(response: { body: unknown }): string {
  return (response.body as { id: string }).id;
}

async function newTask(name: string, key?: string): Promise<string> {
  const created = await world.http("POST", "/v1/tasks", taskBody({ name }), key);
  expect(created.status).toBe(201);
  return idOf(created);
}

async function resultReady(task_run_id: string): Promise<void> {
  turn += 1;
  const observed = await recordRunObservation(
    {
      tenant_id: world.ctx.tenantId,
      task_run_id,
      observation: {
        conversation_status: "active",
        pending_elicitation: null,
        playbook: {
          status: "in_progress",
          revision: turn + 1,
          intact: true,
          result_confirmed: false,
          awaiting_result_confirmation: true,
          progress_marks: [],
        },
        requested_check_at: null,
        turn_id: `5eed0000-0000-4000-8000-${String(turn).padStart(12, "0")}`,
        turn_seq: null,
        turn_driver: "task",
        turn_failure: null,
        turn_interrupted: false,
        human_input_since_last_turn: false,
        progress_marks: [`result:${turn}`],
        result_confirmed_by: null,
        result_rejected: false,
      },
    },
    world.ctx.db,
  );
  expect(observed.run.state).toBe("result_ready");
}

beforeAll(async () => {
  world = await createTaskWorld("operations_task_runs_golden", "task-runs");
  ownerBrowser = await world.browser(world.owner);
  otherBrowser = await world.browser(world.other);
  ownTask = await newTask("Own task");
  foreignTask = await newTask("Foreign task", world.other.key);
}, 120_000);

afterAll(async () => {
  await world.cleanup();
});

describe("task run operations keep their HTTP responses byte for byte", () => {
  test("permission is checked first", async () => {
    const { http, record, denied, enduser } = world;
    const as = (method: string, path: string, key = denied.key) =>
      http(method, path, undefined, key);
    record("http.denied.start", await as("POST", `/v1/tasks/${ownTask}/runs`));
    record("http.denied.list", await as("GET", `/v1/tasks/${ownTask}/runs`));
    record("http.denied.get", await as("GET", `/v1/task-runs/${MISSING}`));
    record("http.denied.abort", await as("POST", `/v1/task-runs/${MISSING}/abort`));
    record("http.denied.complete", await as("POST", `/v1/task-runs/${MISSING}/complete`));
    record("http.denied.reject", await as("POST", `/v1/task-runs/${MISSING}/reject`));
    record("http.enduser.start", await as("POST", `/v1/tasks/${ownTask}/runs`, enduser.key));
    record("http.enduser.get", await as("GET", `/v1/task-runs/${MISSING}`, enduser.key));
  });

  test("start runs as the calling person and queues the first turn", async () => {
    const { http, record, enqueued } = world;
    const started = await http("POST", `/v1/tasks/${ownTask}/runs`);
    firstRun = idOf(started);
    record("http.start", started);
    const run = started.body as { conversation_id: string | null; started_by: string };
    expect(run.conversation_id).not.toBeNull();
    expect(run.started_by).toBe(world.owner.id);
    expect(enqueued).toEqual([firstRun]);
    record("http.start.active", await http("POST", `/v1/tasks/${ownTask}/runs`));
    record("http.start.foreign", await http("POST", `/v1/tasks/${foreignTask}/runs`));
    record("http.start.missing", await http("POST", `/v1/tasks/${MISSING}/runs`));
    record("http.start.invalid", await http("POST", "/v1/tasks/not-a-uuid/runs"));
    const paused = await newTask("Paused task");
    await http("POST", `/v1/tasks/${paused}/pause`);
    record("http.start.paused", await http("POST", `/v1/tasks/${paused}/runs`));
  });

  test("the run conversation is separate and hidden from other people", async () => {
    const { http, record, other, admin } = world;
    record("http.list", await http("GET", `/v1/tasks/${ownTask}/runs`));
    record("http.list.other", await http("GET", `/v1/tasks/${ownTask}/runs`, undefined, other.key));
    record(
      "http.list.admin",
      await http("GET", `/v1/tasks/${ownTask}/runs?limit=1`, undefined, admin.key),
    );
    record("http.list.missing", await http("GET", `/v1/tasks/${MISSING}/runs`));
    record("http.list.invalid", await http("GET", `/v1/tasks/${ownTask}/runs?limit=0`));
    record("http.get", await http("GET", `/v1/task-runs/${firstRun}`));
    record("http.get.other", await http("GET", `/v1/task-runs/${firstRun}`, undefined, other.key));
    record("http.get.admin", await http("GET", `/v1/task-runs/${firstRun}`, undefined, admin.key));
    record("http.get.missing", await http("GET", `/v1/task-runs/${MISSING}`));
  });

  test("abort", async () => {
    const { http, record, other } = world;
    record(
      "http.abort.other",
      await http("POST", `/v1/task-runs/${firstRun}/abort`, undefined, other.key),
    );
    record(
      "http.complete.running",
      await http("POST", `/v1/task-runs/${firstRun}/complete`, undefined, ownerBrowser),
    );
    record(
      "http.reject.running",
      await http("POST", `/v1/task-runs/${firstRun}/reject`, undefined, ownerBrowser),
    );
    record("http.abort", await http("POST", `/v1/task-runs/${firstRun}/abort`));
    record("http.abort.again", await http("POST", `/v1/task-runs/${firstRun}/abort`));
    record("http.abort.missing", await http("POST", `/v1/task-runs/${MISSING}/abort`));
    record(
      "http.complete.aborted",
      await http("POST", `/v1/task-runs/${firstRun}/complete`, undefined, ownerBrowser),
    );
  });

  test("reject reopens the run, complete confirms it", async () => {
    const { http, record, enqueued } = world;
    const started = await http("POST", `/v1/tasks/${ownTask}/runs`);
    secondRun = idOf(started);
    await resultReady(secondRun);
    record(
      "http.complete.other",
      await http("POST", `/v1/task-runs/${secondRun}/complete`, undefined, otherBrowser),
    );
    record(
      "http.reject.other",
      await http("POST", `/v1/task-runs/${secondRun}/reject`, undefined, otherBrowser),
    );
    const before = enqueued.length;
    record(
      "http.reject",
      await http("POST", `/v1/task-runs/${secondRun}/reject`, undefined, ownerBrowser),
    );
    expect(enqueued.slice(before)).toEqual([secondRun]);
    await resultReady(secondRun);
    const { "x-subkit-csrf": _csrf, ...noCsrf } = ownerBrowser;
    for (const action of ["complete", "reject"]) {
      const path = `/v1/task-runs/${secondRun}/${action}`;
      const byKey = await http("POST", path);
      expect(byKey.status).toBe(403);
      expect(JSON.stringify(byKey.body)).toContain("human_session_required");
      const withoutProof = await http("POST", path, undefined, noCsrf);
      expect(withoutProof.status).toBe(403);
      expect(JSON.stringify(withoutProof.body)).toContain("csrf_rejected");
    }
    record(
      "http.complete",
      await http("POST", `/v1/task-runs/${secondRun}/complete`, undefined, ownerBrowser),
    );
    record(
      "http.complete.again",
      await http("POST", `/v1/task-runs/${secondRun}/complete`, undefined, ownerBrowser),
    );
    record(
      "http.reject.completed",
      await http("POST", `/v1/task-runs/${secondRun}/reject`, undefined, ownerBrowser),
    );
    record("http.abort.completed", await http("POST", `/v1/task-runs/${secondRun}/abort`));
    record(
      "http.complete.missing",
      await http("POST", `/v1/task-runs/${MISSING}/complete`, undefined, ownerBrowser),
    );
    record(
      "http.reject.missing",
      await http("POST", `/v1/task-runs/${MISSING}/reject`, undefined, ownerBrowser),
    );
  });

  test("an admin may start and stop a run of another person's task", async () => {
    const { http, record, admin } = world;
    const started = await http("POST", `/v1/tasks/${foreignTask}/runs`, undefined, admin.key);
    record("http.start.admin", started);
    expect((started.body as { started_by: string }).started_by).toBe(admin.id);
    record(
      "http.abort.admin",
      await http("POST", `/v1/task-runs/${idOf(started)}/abort`, undefined, admin.key),
    );
  });

  test("a start whose first turn cannot be queued leaves no open run", async () => {
    const { http } = world;
    const task = await newTask("Unqueued task");
    const recording = defaultTaskServiceDeps.enqueueRunTurn;
    defaultTaskServiceDeps.enqueueRunTurn = async () => {
      throw new Error("queue unavailable");
    };
    try {
      expect((await http("POST", `/v1/tasks/${task}/runs`)).status).toBe(500);
    } finally {
      defaultTaskServiceDeps.enqueueRunTurn = recording;
    }
    const runs = (await http("GET", `/v1/tasks/${task}/runs`)).body as {
      items: Array<{ state: string }>;
    };
    expect(runs.items.map((run) => run.state)).toEqual(["aborted"]);
    expect((await http("POST", `/v1/tasks/${task}/runs`)).status).toBe(201);
  });

  test("a waiting run quotes its open question to the owner and an admin", async () => {
    const { http, record, admin, other, ctx } = world;
    const task = await newTask("Asking task");
    const started = await http("POST", `/v1/tasks/${task}/runs`);
    const run = started.body as { id: string; conversation_id: string };
    expect((await http("GET", `/v1/task-runs/${run.id}`)).body).toMatchObject({
      pending_question: null,
    });
    await ctx.db.insert(conversationElicitations).values({
      tenant_id: ctx.tenantId,
      conversation_id: run.conversation_id,
      tool_name: "ask_user_text",
      summary: `Which week should the report cover? ${"x".repeat(400)}`,
      input: {},
    });
    turn += 1;
    await recordRunObservation(
      {
        tenant_id: ctx.tenantId,
        task_run_id: run.id,
        observation: {
          conversation_status: "awaiting_input",
          pending_elicitation: "question",
          playbook: {
            status: "waiting_for_input",
            revision: 2,
            intact: true,
            result_confirmed: false,
            awaiting_result_confirmation: false,
            progress_marks: [],
          },
          requested_check_at: null,
          turn_id: `5eed0000-0000-4000-8000-${String(turn).padStart(12, "0")}`,
          turn_seq: null,
          turn_driver: "task",
          turn_failure: null,
          turn_interrupted: false,
          human_input_since_last_turn: false,
          progress_marks: ["result:question"],
          result_confirmed_by: null,
          result_rejected: false,
        },
      },
      ctx.db,
    );
    const waiting = await http("GET", `/v1/task-runs/${run.id}`);
    record("http.get.waiting", waiting);
    const question = (waiting.body as { pending_question: string }).pending_question;
    expect(question.startsWith("Which week should the report cover?")).toBe(true);
    expect(question).toHaveLength(300);
    expect((await http("GET", `/v1/task-runs/${run.id}`, undefined, admin.key)).body).toMatchObject(
      { pending_question: question },
    );
    expect((await http("GET", `/v1/task-runs/${run.id}`, undefined, other.key)).status).toBe(404);
    expect((await http("GET", `/v1/tasks/${task}`)).body).toMatchObject({
      latest_run: { id: run.id, state: "waiting", waiting_reason: "question" },
    });
    await http("POST", `/v1/task-runs/${run.id}/abort`);
    expect((await http("GET", `/v1/task-runs/${run.id}`)).body).toMatchObject({
      state: "aborted",
      pending_question: null,
    });
  });

  test("audit rows", async () => {
    const { record, auditTrail } = world;
    record("http.audit.first", await auditTrail(firstRun));
    record("http.audit.second", await auditTrail(secondRun));
  });
});

describe("task run tools keep their results byte for byte", () => {
  let task: string;
  let run: string;

  test("run_task returns the run, its state and the Cockpit path", async () => {
    const { record, toolCtx, owner, other, enqueued } = world;
    task = await newTask("Tool task");
    const caller = toolCtx(owner);
    const started = await runTaskTool.execute(caller, { task_id: task });
    record("tool.run", started);
    const data = (started as { data: Record<string, string> }).data;
    run = data.task_run_id as string;
    expect(data.cockpit_path).toBe(`/cockpit/tasks/${task}`);
    expect(data.conversation_id).not.toBe(caller.conversation_id);
    expect(enqueued.at(-1)).toBe(run);
    record("tool.run.active", await runTaskTool.execute(toolCtx(owner), { task_id: task }));
    record("tool.run.foreign", await runTaskTool.execute(toolCtx(other), { task_id: task }));
    record("tool.run.missing", await runTaskTool.execute(toolCtx(owner), { task_id: MISSING }));
    record("tool.run.no-principal", await runTaskTool.execute(toolCtx(null), { task_id: task }));
  });

  test("get_task_run", async () => {
    const { record, toolCtx, owner, other } = world;
    record("tool.get", await getTaskRunTool.execute(toolCtx(owner), { id: run }));
    record("tool.get.foreign", await getTaskRunTool.execute(toolCtx(other), { id: run }));
    record("tool.get.missing", await getTaskRunTool.execute(toolCtx(owner), { id: MISSING }));
  });

  test("abort_task_run", async () => {
    const { record, toolCtx, owner, other } = world;
    record(
      "tool.abort.foreign",
      await abortTaskRunTool.execute(toolCtx(other), { task_run_id: run }),
    );
    record("tool.abort", await abortTaskRunTool.execute(toolCtx(owner), { task_run_id: run }));
    record(
      "tool.abort.missing",
      await abortTaskRunTool.execute(toolCtx(owner), { task_run_id: MISSING }),
    );
    record("tool.audit", await world.auditTrail(run));
  });

  test("neither tool acts from inside a task run", async () => {
    const { record, toolCtx, owner } = world;
    const inside = toolCtx(owner);
    await inside.setDraft({
      ...inside.getDraft(),
      session: {
        ...inside.getDraft().session,
        task_run: {
          task_id: task,
          task_run_id: run,
          environment: "dev",
          workflow_ids: [],
          connector_ids: [],
          web_search: false,
        },
      },
    } as never);
    record("tool.run.inside-run", await runTaskTool.execute(inside, { task_id: task }));
    record("tool.abort.inside-run", await abortTaskRunTool.execute(inside, { task_run_id: run }));
  });

  test("the golden file has no stale entries", () => {
    const keys = world.staleKeys();
    expect(keys.actual).toEqual(keys.golden);
  });
});
