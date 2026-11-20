import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createConversation, updatePlaybook } from "../../../conversations/public/authoring.ts";
import {
  findTaskTool,
  getTaskTool,
  listTasksTool,
} from "../../../conversations/tools/engine-api/tasks.ts";
import { saveTaskTool } from "../../../conversations/tools/engine-api/writes/tasks.ts";
import { createTaskWorld, MISSING, type TaskWorld, taskBody } from "./task-golden-world.ts";

let world: TaskWorld;
let ownId: string;
let foreignId: string;
let pausedId: string;

function idOf(response: { body: unknown }): string {
  return (response.body as { id: string }).id;
}

function update(revision: number, overrides: Record<string, unknown> = {}) {
  return { ...taskBody(), expected_revision: revision, ...overrides };
}

beforeAll(async () => {
  world = await createTaskWorld("operations_tasks_golden", "tasks");
}, 120_000);

afterAll(async () => {
  await world.cleanup();
});

describe("task operations keep their HTTP responses byte for byte", () => {
  test("permission is checked before the body is validated", async () => {
    const { http, record, denied, enduser } = world;
    record("http.denied.list", await http("GET", "/v1/tasks", undefined, denied.key));
    record("http.denied.create", await http("POST", "/v1/tasks", { name: "" }, denied.key));
    record("http.denied.get", await http("GET", `/v1/tasks/${MISSING}`, undefined, denied.key));
    record("http.denied.update", await http("PUT", `/v1/tasks/${MISSING}`, {}, denied.key));
    record(
      "http.denied.delete",
      await http("DELETE", `/v1/tasks/${MISSING}`, undefined, denied.key),
    );
    record(
      "http.denied.pause",
      await http("POST", `/v1/tasks/${MISSING}/pause`, undefined, denied.key),
    );
    record(
      "http.denied.resume",
      await http("POST", `/v1/tasks/${MISSING}/resume`, undefined, denied.key),
    );
    record("http.enduser.list", await http("GET", "/v1/tasks", undefined, enduser.key));
    record("http.enduser.create", await http("POST", "/v1/tasks", taskBody(), enduser.key));
  });

  test("create", async () => {
    const { http, record, other } = world;
    const created = await http("POST", "/v1/tasks", taskBody({ category: "reports" }));
    ownId = idOf(created);
    record("http.create", created);
    const foreign = await http("POST", "/v1/tasks", taskBody({ name: "Foreign task" }), other.key);
    foreignId = idOf(foreign);
    expect(foreign.status).toBe(201);
    record("http.create.invalid", await http("POST", "/v1/tasks", { name: "" }));
    record(
      "http.create.plan-cancelled",
      await http("POST", "/v1/tasks", taskBody({ plan: { ...taskBody().plan, cancelled: true } })),
    );
    record(
      "http.create.schedule-too-frequent",
      await http(
        "POST",
        "/v1/tasks",
        taskBody({ schedule_cron: "* * * * *", schedule_timezone: "Europe/Berlin" }),
      ),
    );
    record(
      "http.create.schedule-both",
      await http(
        "POST",
        "/v1/tasks",
        taskBody({
          schedule_cron: "0 8 * * 1",
          schedule_timezone: "Europe/Berlin",
          schedule_run_at: "2031-01-01T08:00:00.000Z",
        }),
      ),
    );
  });

  test("a person sees own tasks, an admin sees all", async () => {
    const { http, record, other, admin } = world;
    record("http.list.owner", await http("GET", "/v1/tasks?sort=name"));
    record("http.list.other", await http("GET", "/v1/tasks?sort=name", undefined, other.key));
    record("http.list.admin", await http("GET", "/v1/tasks?sort=name", undefined, admin.key));
    record("http.list.page", await http("GET", "/v1/tasks?limit=1&offset=1", undefined, admin.key));
    record("http.list.q", await http("GET", "/v1/tasks?q=Foreign", undefined, admin.key));
    record("http.list.category", await http("GET", "/v1/tasks?category=reports"));
    record("http.list.invalid", await http("GET", "/v1/tasks?limit=0"));
    record("http.get", await http("GET", `/v1/tasks/${ownId}`));
    record("http.get.admin", await http("GET", `/v1/tasks/${foreignId}`, undefined, admin.key));
    record("http.get.foreign", await http("GET", `/v1/tasks/${foreignId}`));
    record("http.get.missing", await http("GET", `/v1/tasks/${MISSING}`));
    record("http.get.invalid", await http("GET", "/v1/tasks/not-a-uuid"));
  });

  test("a foreign task answers as not found on every write", async () => {
    const { http, record } = world;
    record("http.foreign.update", await http("PUT", `/v1/tasks/${foreignId}`, update(1)));
    record("http.foreign.delete", await http("DELETE", `/v1/tasks/${foreignId}`));
    record("http.foreign.pause", await http("POST", `/v1/tasks/${foreignId}/pause`));
    record("http.foreign.resume", await http("POST", `/v1/tasks/${foreignId}/resume`));
  });

  test("update", async () => {
    const { http, record } = world;
    record(
      "http.update.metadata",
      await http("PUT", `/v1/tasks/${ownId}`, update(1, { name: "Weekly report, renamed" })),
    );
    record(
      "http.update.content",
      await http("PUT", `/v1/tasks/${ownId}`, update(2, { done_when: "The report was sent" })),
    );
    record("http.update.stale", await http("PUT", `/v1/tasks/${ownId}`, update(1)));
    record("http.update.invalid", await http("PUT", `/v1/tasks/${ownId}`, taskBody()));
    record("http.update.missing", await http("PUT", `/v1/tasks/${MISSING}`, update(1)));
  });

  test("pause and resume", async () => {
    const { http, record, other, admin } = world;
    record("http.pause", await http("POST", `/v1/tasks/${ownId}/pause`));
    record("http.pause.again", await http("POST", `/v1/tasks/${ownId}/pause`));
    record("http.resume", await http("POST", `/v1/tasks/${ownId}/resume`));
    record("http.resume.again", await http("POST", `/v1/tasks/${ownId}/resume`));
    record(
      "http.pause.admin",
      await http("POST", `/v1/tasks/${foreignId}/pause`, undefined, admin.key),
    );
    record(
      "http.resume.owner-after-admin",
      await http("POST", `/v1/tasks/${foreignId}/resume`, undefined, other.key),
    );
    record("http.pause.missing", await http("POST", `/v1/tasks/${MISSING}/pause`));
  });

  test("delete archives", async () => {
    const { http, record } = world;
    const doomed = await http("POST", "/v1/tasks", taskBody({ name: "Doomed" }));
    pausedId = idOf(doomed);
    record("http.delete", await http("DELETE", `/v1/tasks/${pausedId}`));
    record("http.delete.again", await http("DELETE", `/v1/tasks/${pausedId}`));
    record("http.get.archived", await http("GET", `/v1/tasks/${pausedId}`));
    record("http.list.archived", await http("GET", "/v1/tasks?lifecycle=archived"));
    record("http.update.archived", await http("PUT", `/v1/tasks/${pausedId}`, update(1)));
  });

  test("audit rows name the acting person", async () => {
    const { record, auditTrail } = world;
    record("http.audit.own", await auditTrail(ownId));
    record("http.audit.foreign", await auditTrail(foreignId));
    record("http.audit.archived", await auditTrail(pausedId));
  });
});

describe("the task view carries what a list row needs", () => {
  let scheduled: string;

  test("a new manual task has no run, no standing permission and no next start", async () => {
    const { http } = world;
    const created = await http("POST", "/v1/tasks", taskBody({ name: "View manual" }));
    const view = (await http("GET", `/v1/tasks/${idOf(created)}`)).body;
    expect(view).toMatchObject({ latest_run: null, grant_live: false, next_start_at: null });
  });

  test("a scheduled task names its next start; pausing clears it", async () => {
    const { http } = world;
    const created = await http(
      "POST",
      "/v1/tasks",
      taskBody({ name: "View scheduled", schedule_cron: "0 8 * * 1", schedule_timezone: "UTC" }),
    );
    scheduled = idOf(created);
    const view = (await http("GET", `/v1/tasks/${scheduled}`)).body as {
      next_start_at: string;
      updated_at: string;
    };
    const next = new Date(view.next_start_at);
    expect(next.getTime()).toBeGreaterThan(new Date(view.updated_at).getTime());
    expect([next.getUTCDay(), next.getUTCHours(), next.getUTCMinutes()]).toEqual([1, 8, 0]);
    await http("POST", `/v1/tasks/${scheduled}/pause`);
    expect((await http("GET", `/v1/tasks/${scheduled}`)).body).toMatchObject({
      next_start_at: null,
    });
    await http("POST", `/v1/tasks/${scheduled}/resume`);
  });

  test("a one-time start shows until it is claimed", async () => {
    const { http } = world;
    const at = "2031-01-01T08:00:00.000Z";
    const created = await http(
      "POST",
      "/v1/tasks",
      taskBody({ name: "View once", schedule_run_at: at }),
    );
    expect((await http("GET", `/v1/tasks/${idOf(created)}`)).body).toMatchObject({
      next_start_at: at,
    });
  });

  test("the standing permission counts while it matches the task", async () => {
    const { http, owner } = world;
    const browser = await world.browser(owner);
    const task = (await http("GET", `/v1/tasks/${scheduled}`)).body as { fingerprint: string };
    const granted = await http(
      "POST",
      `/v1/tasks/${scheduled}/grants`,
      {
        expected_fingerprint: task.fingerprint,
        valid_until: null,
        max_runs: 1,
        expected_workflow_digests: {},
      },
      browser,
    );
    expect(granted.status).toBe(201);
    const listed = (await http("GET", "/v1/tasks?q=View&sort=name")).body as {
      items: Array<{ name: string; grant_live: boolean }>;
    };
    expect(listed.items.map((item) => [item.name, item.grant_live])).toEqual([
      ["View manual", false],
      ["View once", false],
      ["View scheduled", true],
    ]);
    const grant_id = (granted.body as { grant: { id: string } }).grant.id;
    await http("POST", `/v1/tasks/${scheduled}/grants/${grant_id}/revoke`, undefined, browser);
    expect((await http("GET", `/v1/tasks/${scheduled}`)).body).toMatchObject({
      grant_live: false,
    });
  });

  test("the latest run is the newest one, in list and detail", async () => {
    const { http } = world;
    const first = await http("POST", `/v1/tasks/${scheduled}/runs`);
    await http("POST", `/v1/task-runs/${idOf(first)}/abort`);
    const second = await http("POST", `/v1/tasks/${scheduled}/runs`);
    const run = second.body as { id: string; conversation_id: string; created_at: string };
    const expected = {
      id: run.id,
      state: "running",
      waiting_reason: null,
      next_check_at: null,
      started_at: run.created_at,
      ended_at: null,
      conversation_id: run.conversation_id,
    };
    expect((await http("GET", `/v1/tasks/${scheduled}`)).body).toMatchObject({
      latest_run: expected,
    });
    const listed = (await http("GET", "/v1/tasks?q=View%20scheduled")).body as {
      items: Array<{ latest_run: unknown }>;
    };
    expect(listed.items[0]?.latest_run).toEqual(expected);
    await http("POST", `/v1/task-runs/${run.id}/abort`);
  });
});

describe("task usage", () => {
  test("permission, visibility and the shape of an unused task", async () => {
    const { http, record, denied, other, admin } = world;
    record(
      "http.usage.denied",
      await http("GET", `/v1/tasks/${ownId}/usage`, undefined, denied.key),
    );
    record("http.usage", await http("GET", `/v1/tasks/${ownId}/usage`));
    record("http.usage.admin", await http("GET", `/v1/tasks/${ownId}/usage`, undefined, admin.key));
    record(
      "http.usage.foreign",
      await http("GET", `/v1/tasks/${ownId}/usage`, undefined, other.key),
    );
    record("http.usage.missing", await http("GET", `/v1/tasks/${MISSING}/usage`));
    record("http.usage.archived", await http("GET", `/v1/tasks/${pausedId}/usage`));
  });
});

describe("task read tools keep their results byte for byte", () => {
  test("list_tasks", async () => {
    const { record, toolCtx, owner, other, admin } = world;
    record("tool.list.owner", await listTasksTool.execute(toolCtx(owner), {}));
    record("tool.list.other", await listTasksTool.execute(toolCtx(other), {}));
    record("tool.list.admin.page", await listTasksTool.execute(toolCtx(admin), { limit: 1 }));
    record(
      "tool.list.archived",
      await listTasksTool.execute(toolCtx(owner), { lifecycle: "archived" }),
    );
    record("tool.list.no-principal", await listTasksTool.execute(toolCtx(null), {}));
  });

  test("find_task", async () => {
    const { record, toolCtx, owner, admin } = world;
    record("tool.find", await findTaskTool.execute(toolCtx(owner), { query: "weekly" }));
    record("tool.find.foreign", await findTaskTool.execute(toolCtx(owner), { query: "Foreign" }));
    record("tool.find.admin", await findTaskTool.execute(toolCtx(admin), { query: "Foreign" }));
  });

  test("get_task", async () => {
    const { record, toolCtx, owner } = world;
    record("tool.get", await getTaskTool.execute(toolCtx(owner), { id: ownId }));
    record("tool.get.foreign", await getTaskTool.execute(toolCtx(owner), { id: foreignId }));
    record("tool.get.missing", await getTaskTool.execute(toolCtx(owner), { id: MISSING }));
  });
});

describe("save_task stores a task for the calling person", () => {
  const explicit = {
    name: "Chat task",
    goal: "Tidy the shared inbox",
    done_when: "No message is older than a day",
    environment: "dev",
    plan: {
      ...taskBody().plan,
      steps: [
        {
          ...taskBody().plan.steps[0],
          evidence_ids: ["5eed0000-0000-4000-8000-000000000001"],
          note: "Seen in this chat",
          progress: "in_progress",
          criterion: {
            kind: "assessment",
            description: "Numbers are complete",
            result: "A result that only belongs to the conversation it came from.",
          },
        },
      ],
    },
  };
  let savedId: string;

  test("create with an explicit plan keeps no evidence of the chat", async () => {
    const { record, toolCtx, owner, http } = world;
    const saved = await saveTaskTool.execute(toolCtx(owner), explicit);
    savedId = (saved as { data: { task_id: string } }).data.task_id;
    record("tool.save.create", saved);
    record("tool.save.create.stored", await http("GET", `/v1/tasks/${savedId}`));
  });

  test("create takes the plan from the conversation playbook", async () => {
    const { record, toolCtx, owner, ctx, http } = world;
    const { conversation } = await createConversation(
      {
        tenant_id: ctx.tenantId,
        actor_id: owner.id,
        principal: owner.principal,
        title: "Planning chat",
        permission_mode: "ask",
        surface: "web",
        playbook_mode: "auto",
      },
      ctx.db,
    );
    const scope = { conversation_id: conversation.id };
    const { plan: _plan, ...withoutPlan } = explicit;
    record("tool.save.no-plan", await saveTaskTool.execute(toolCtx(owner, scope), withoutPlan));
    await updatePlaybook(
      ctx.db,
      { tenant_id: ctx.tenantId, conversation_id: conversation.id, principal: owner.principal },
      { expected_revision: 0, plan: { ...taskBody().plan, title: "Plan from the chat" } },
    );
    const saved = await saveTaskTool.execute(toolCtx(owner, scope), {
      ...withoutPlan,
      name: "From playbook",
    });
    record("tool.save.from-playbook", saved);
    const id = (saved as { data: { task_id: string } }).data.task_id;
    const stored = await http("GET", `/v1/tasks/${id}`);
    expect((stored.body as { plan: { title: string; goal: string } }).plan).toMatchObject({
      title: "Plan from the chat",
      goal: explicit.goal,
    });
  });

  test("incomplete and invalid input is refused with the fields named", async () => {
    const { record, toolCtx, owner } = world;
    record(
      "tool.save.incomplete",
      await saveTaskTool.execute(toolCtx(owner), { name: "Half", plan: explicit.plan }),
    );
    record(
      "tool.save.schedule-too-frequent",
      await saveTaskTool.execute(toolCtx(owner), {
        ...explicit,
        schedule_cron: "* * * * *",
        schedule_timezone: "Europe/Berlin",
      }),
    );
  });

  test("update needs the current revision and keeps untouched fields", async () => {
    const { record, toolCtx, owner, other, http } = world;
    record(
      "tool.save.update.no-revision",
      await saveTaskTool.execute(toolCtx(owner), { task_id: savedId, name: "Renamed" }),
    );
    record(
      "tool.save.update.stale",
      await saveTaskTool.execute(toolCtx(owner), {
        task_id: savedId,
        expected_revision: 9,
        name: "Renamed",
      }),
    );
    record(
      "tool.save.update.foreign",
      await saveTaskTool.execute(toolCtx(other), {
        task_id: savedId,
        expected_revision: 1,
        name: "Taken over",
      }),
    );
    record(
      "tool.save.update",
      await saveTaskTool.execute(toolCtx(owner), {
        task_id: savedId,
        expected_revision: 1,
        name: "Renamed",
        web_search: true,
      }),
    );
    record("tool.save.update.stored", await http("GET", `/v1/tasks/${savedId}`));
    record("tool.save.audit", await world.auditTrail(savedId));
  });

  test("the caller comes from the session, never from input", async () => {
    const { record, toolCtx, owner, other, http } = world;
    const saved = await saveTaskTool.execute(toolCtx(other), {
      ...explicit,
      name: "Owner from session",
      owner_id: owner.id,
    });
    const id = (saved as { data: { task_id: string } }).data.task_id;
    const stored = await http("GET", `/v1/tasks/${id}`, undefined, other.key);
    expect((stored.body as { owner_id: string }).owner_id).toBe(other.id);
    record("tool.save.no-principal", await saveTaskTool.execute(toolCtx(null), explicit));
  });

  test("refused over MCP without the authoring scope and inside a task run", async () => {
    const { record, toolCtx, owner } = world;
    const product = toolCtx(
      { ...owner, principal: { ...owner.principal, scopes: [] } },
      { surface: "mcp" },
    );
    record("tool.save.mcp-product", await saveTaskTool.execute(product, explicit));
    const authoring = toolCtx(
      { ...owner, principal: { ...owner.principal, scopes: ["mcp:authoring"] } },
      { surface: "mcp" },
    );
    const allowed = await saveTaskTool.execute(authoring, { ...explicit, name: "Over MCP" });
    expect(allowed.ok).toBe(true);
    const inside = toolCtx(owner);
    await inside.setDraft({
      ...inside.getDraft(),
      session: {
        ...inside.getDraft().session,
        task_run: {
          task_id: MISSING,
          task_run_id: MISSING,
          environment: "dev",
          workflow_ids: [],
          connector_ids: [],
          web_search: false,
        },
      },
    } as never);
    record("tool.save.inside-run", await saveTaskTool.execute(inside, explicit));
  });

  test("the golden file has no stale entries", () => {
    const keys = world.staleKeys();
    expect(keys.actual).toEqual(keys.golden);
  });
});
