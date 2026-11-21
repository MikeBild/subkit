import { afterEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@/api/client";
import { keyId, keysForEvent } from "@/app/live-invalidation";
import { patchCatalogMetadata } from "@/features/catalog/api/catalog-metadata-api";
import { task } from "../model/tasks-fixtures";
import { draftFromTask, startErrorKey, taskBody } from "../model/tasks-model";
import {
  abortTaskRun,
  completeTaskRun,
  createTask,
  deleteTask,
  listAllTasks,
  pauseTask,
  rejectTaskRun,
  resumeTask,
  startTaskRun,
  taskKeys,
  updateTask,
} from "./tasks-queries";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function answer(respond: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      path: new URL(String(input), "http://cockpit.test").pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const response = respond(call);
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

const body = () => {
  const built = taskBody(draftFromTask(task(), "UTC"), task(), Date.parse("2026-11-19T10:00:00Z"));
  if (!built.ok) throw new Error(built.issue);
  return built.body;
};

describe("task requests", () => {
  test("every action calls its documented route", async () => {
    const calls = answer(() => ({ status: 200, body: task() }));
    await createTask(body());
    await updateTask("t 1", body(), 3);
    await deleteTask("t1");
    await pauseTask("t1");
    await resumeTask("t1");
    await startTaskRun("t1");
    await abortTaskRun("r1");
    await completeTaskRun("r1");
    await rejectTaskRun("r1");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/tasks",
      "PUT /v1/tasks/t%201",
      "DELETE /v1/tasks/t1",
      "POST /v1/tasks/t1/pause",
      "POST /v1/tasks/t1/resume",
      "POST /v1/tasks/t1/runs",
      "POST /v1/task-runs/r1/abort",
      "POST /v1/task-runs/r1/complete",
      "POST /v1/task-runs/r1/reject",
    ]);
  });

  test("an update carries the revision the person started from", async () => {
    const calls = answer(() => ({ status: 200, body: task() }));
    await updateTask("t1", body(), 3);
    expect(calls[0]?.body).toMatchObject({ expected_revision: 3, name: "Rechnungen nachfassen" });
    await createTask(body());
    expect(calls[1]?.body).not.toHaveProperty("expected_revision");
  });

  test("a revision conflict surfaces its code so the form can ask to reload", async () => {
    answer(() => ({
      status: 409,
      body: { code: "task_revision_conflict", message: "The task changed." },
    }));
    const failure = await updateTask("t1", body(), 2).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("task_revision_conflict");
  });

  test("a refused or failing manual start maps to one sentence with a next step", async () => {
    answer(() => ({
      status: 409,
      body: { code: "previous_run_active", message: "This task already has a run in progress." },
    }));
    const refused = await startTaskRun("t1").catch((error: unknown) => error);
    expect(startErrorKey((refused as ApiError).code)).toBe("tasks.start.error.active");
    answer(() => ({ status: 500, body: { code: "internal_error", message: "not wired" } }));
    const broken = await startTaskRun("t1").catch((error: unknown) => error);
    expect(broken).toBeInstanceOf(ApiError);
    expect(startErrorKey((broken as ApiError).code)).toBe("tasks.start.error.other");
  });

  test("catalog metadata of a task is saved through the task itself, at its revision", async () => {
    const stored = task({ category: "billing", description: "Alt", revision: 7 });
    const calls = answer(() => ({ status: 200, body: stored }));
    await patchCatalogMetadata("task", stored.id, { description: "Neu", category: null });
    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(calls[1]?.path).toBe(`/v1/tasks/${stored.id}`);
    expect(calls[1]?.body).toMatchObject({
      description: "Neu",
      expected_revision: 7,
      goal: stored.goal,
      plan: stored.plan,
    });
    expect(calls[1]?.body).not.toHaveProperty("category");
    await patchCatalogMetadata("task", stored.id, { name: "Neuer Name" });
    expect(calls[3]?.body).toMatchObject({
      name: "Neuer Name",
      description: "Alt",
      category: "billing",
    });
  });
});

describe("the task list", () => {
  test("loads every page until the reported total is reached, without a request per task", async () => {
    const all = Array.from({ length: 450 }, (_, index) => task({ id: `t-${index}` }));
    const offsets: number[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://cockpit.test");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit"));
      offsets.push(offset);
      expect(url.pathname.endsWith("/v1/tasks")).toBe(true);
      return new Response(
        JSON.stringify({ items: all.slice(offset, offset + limit), total: all.length }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const listed = await listAllTasks("");
    expect(listed.items).toHaveLength(450);
    expect(listed.total).toBe(450);
    expect(offsets).toEqual([0, 200, 400]);
  });

  test("stops when a page comes back empty although the total says more", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return new Response(JSON.stringify({ items: calls === 1 ? [task()] : [], total: 5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const listed = await listAllTasks("x");
    expect(listed.items).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

describe("live refresh of task pages", () => {
  const ids = (type: string) => keysForEvent(type).map(keyId);

  test("task and run events refresh exactly the reads of the task pages", () => {
    for (const key of [taskKeys.list(""), taskKeys.detail("t"), taskKeys.grantsOf("t")])
      for (const type of ["task.changed", "task.grant_changed", "task_run.changed"])
        expect(ids(type)).toContain(keyId([key[0]]));
    for (const key of [taskKeys.runs("t"), taskKeys.playbook("c"), taskKeys.usage("t")])
      expect(ids("task_run.changed")).toContain(keyId([key[0]]));
    expect(ids("task.changed")).not.toContain(keyId(["task-runs"]));
    expect(ids("task_run.changed")).toContain(keyId([taskKeys.run("r")[0]]));
    expect(ids("task.changed")).not.toContain(keyId(["task-run"]));
    for (const type of ["task.changed", "task.grant_changed", "task_run.changed"])
      expect(ids(type)).toContain(keyId([taskKeys.grantPreview("t")[0]]));
    for (const key of [["workflow-authorities"], ["workflow-automation-status"], ["decisions"]]) {
      expect(ids("task.grant_changed")).toContain(keyId(key));
      expect(ids("task.changed")).not.toContain(keyId(key));
    }
    for (const type of ["task.changed", "task_run.changed"]) {
      expect(ids(type)).toContain(keyId(["attention"]));
      expect(ids(type)).toContain(keyId(["audit"]));
    }
    expect(taskKeys.history("t")[0]).toBe("audit");
  });
});
