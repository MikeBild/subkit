import { describe, expect, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  auditLog,
  conversationElicitations,
  conversations,
  conversationTurns,
  taskGrants,
  taskRuns,
  tasks,
} from "../db/schema/index.ts";
import { getMetrics } from "../observability/metrics.ts";
import { taskStartsHeld } from "../operator/operational-overview.ts";
import {
  db,
  ownedTask,
  taskInput,
  useTaskRunQueue,
  type Workspace,
  workspace,
} from "../queue/handlers/task-run-turn-fixtures.ts";
import { createSkill } from "../skills/service.ts";
import {
  getTask,
  pauseTask,
  resumeTask,
  TASK_RUN_SEED_SKILL,
  type Task,
  type TaskServiceDeps,
  updateTask,
} from "../tasks/index.ts";
import { withTaskListView } from "../tasks/list-view.ts";
import { runTaskSweep, sweepTenantTasks } from "./task-sweep.ts";

useTaskRunQueue("task_sweep");

const CREATED = new Date("2027-03-26T12:00:00.000Z");
const at = (iso: string) => new Date(iso);

function clock(now: Date): { deps: Partial<TaskServiceDeps>; enqueued: string[] } {
  const enqueued: string[] = [];
  return {
    enqueued,
    deps: {
      now: () => now,
      aiAccessConfigured: async () => true,
      enqueueRunTurn: async (_db, params) => {
        enqueued.push(params.task_run_id);
      },
    },
  };
}

async function scheduled(w: Workspace, schedule: Partial<ReturnType<typeof taskInput>>) {
  const task = await ownedTask(w, taskInput(schedule), { now: () => CREATED });
  await db
    .update(tasks)
    .set({ updated_at: CREATED, created_at: CREATED })
    .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
  return task;
}

const daily = { schedule_cron: "0 8 * * *", schedule_timezone: "Europe/Berlin" };

async function grant(w: Workspace, task: Task): Promise<void> {
  await db.insert(taskGrants).values({
    tenant_id: w.tenant_id,
    task_id: task.id,
    fingerprint: task.fingerprint,
    environment: task.environment,
    valid_from: at("2026-01-01T00:00:00.000Z"),
    created_by: w.owner.id,
  });
}

async function storedTask(w: Workspace, task: Task): Promise<Task> {
  const stored = await getTask(
    { tenant_id: w.tenant_id, principal: w.owner, task_id: task.id },
    db,
  );
  if (!stored) throw new Error("missing task");
  return stored;
}

async function runs(w: Workspace, task: Task) {
  return await db
    .select()
    .from(taskRuns)
    .where(and(eq(taskRuns.tenant_id, w.tenant_id), eq(taskRuns.task_id, task.id)))
    .orderBy(asc(taskRuns.created_at));
}

async function settle(w: Workspace, task: Task, state: "completed" | "result_ready" | "waiting") {
  await db
    .update(taskRuns)
    .set({ state, waiting_reason: state === "waiting" ? "question" : null })
    .where(
      and(
        eq(taskRuns.tenant_id, w.tenant_id),
        eq(taskRuns.task_id, task.id),
        eq(taskRuns.state, "running"),
      ),
    );
}

async function taskAudit(w: Workspace, task: Task, action: string) {
  return await db
    .select({ result: auditLog.result, reason: auditLog.reason, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, w.tenant_id),
        eq(auditLog.resource_id, task.id),
        eq(auditLog.action, action),
      ),
    )
    .orderBy(asc(auditLog.ts), asc(auditLog.id));
}

async function sweep(w: Workspace, iso: string): Promise<string[]> {
  const { deps, enqueued } = clock(at(iso));
  await sweepTenantTasks(db, w.tenant_id, at(iso), deps);
  return enqueued;
}

async function hold(w: Workspace, task: Task) {
  const [row] = await db
    .select({ reason: tasks.admission_hold_reason, since: tasks.admission_hold_since })
    .from(tasks)
    .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
  return row;
}

describe("the task sweep starts scheduled tasks", () => {
  test("two replicas sweeping at once start exactly one run", async () => {
    const w = await workspace();
    const task = await scheduled(w, daily);
    await grant(w, task);
    const now = at("2027-03-27T07:00:00.000Z");
    const first = clock(now);
    const second = clock(now);
    await Promise.all([runTaskSweep(db, now, first.deps), runTaskSweep(db, now, second.deps)]);
    await runTaskSweep(db, now, first.deps);
    const started = await runs(w, task);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ trigger: "cron", state: "running", started_by: null });
    expect(new Set([...first.enqueued, ...second.enqueued])).toEqual(
      new Set([started[0]?.id ?? ""]),
    );
    await settle(w, task, "completed");
  }, 180_000);

  test("a daily task follows its timezone across the clock change and catches up once", async () => {
    const w = await workspace();
    const task = await scheduled(w, daily);
    await grant(w, task);
    expect(await sweep(w, "2027-03-27T06:59:59.000Z")).toEqual([]);
    expect(await sweep(w, "2027-03-27T07:00:00.000Z")).toHaveLength(1);
    await settle(w, task, "completed");
    expect(await sweep(w, "2027-03-27T07:05:00.000Z")).toEqual([]);
    expect(await sweep(w, "2027-03-28T05:59:59.000Z")).toEqual([]);
    expect(await sweep(w, "2027-03-28T06:00:00.000Z")).toHaveLength(1);
    await settle(w, task, "completed");
    expect(await sweep(w, "2027-04-02T12:00:00.000Z")).toHaveLength(1);
    await settle(w, task, "completed");
    expect(await sweep(w, "2027-04-02T12:01:00.000Z")).toEqual([]);
    expect(await sweep(w, "2027-04-03T05:59:00.000Z")).toEqual([]);
    const started = await runs(w, task);
    expect(started.map((run) => run.trigger)).toEqual(["cron", "cron", "cron"]);
    const claims = await taskAudit(w, task, "task.schedule_claimed");
    expect(claims.map((row) => (row.metadata as { task_run_id: string }).task_run_id)).toEqual(
      started.map((run) => run.id),
    );
    expect(await taskAudit(w, task, "task.admission.changed")).toEqual([]);
  }, 180_000);

  test("a one-time task starts once", async () => {
    const w = await workspace();
    const task = await scheduled(w, { schedule_run_at: "2027-03-26T13:00:00.000Z" });
    await grant(w, task);
    expect(await sweep(w, "2027-03-26T12:59:00.000Z")).toEqual([]);
    expect(await sweep(w, "2027-03-26T13:00:00.000Z")).toHaveLength(1);
    await settle(w, task, "completed");
    expect(await sweep(w, "2027-03-27T13:00:00.000Z")).toEqual([]);
    expect((await runs(w, task)).map((run) => run.trigger)).toEqual(["once"]);
  }, 180_000);

  test("a held start writes one audit row, stays quiet, and starts once it is permitted", async () => {
    const w = await workspace();
    const task = await scheduled(w, daily);
    expect(await sweep(w, "2027-03-27T07:00:00.000Z")).toEqual([]);
    expect(await sweep(w, "2027-03-27T07:01:00.000Z")).toEqual([]);
    expect(await sweep(w, "2027-03-28T09:00:00.000Z")).toEqual([]);
    expect(await runs(w, task)).toEqual([]);
    const held = await taskAudit(w, task, "task.admission.changed");
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      result: "denied",
      reason: "grant_required",
      metadata: { state: "held", reason_code: "grant_required", trigger: "cron" },
    });
    expect(await hold(w, task)).toEqual({
      reason: "grant_required",
      since: at("2027-03-27T07:00:00.000Z"),
    });
    expect((await db.execute(taskStartsHeld(w.tenant_id))).rows).toHaveLength(1);
    expect(await taskAudit(w, task, "task.schedule_claimed")).toEqual([]);

    await grant(w, task);
    expect(await sweep(w, "2027-03-28T09:05:00.000Z")).toHaveLength(1);
    expect(await hold(w, task)).toEqual({ reason: null, since: null });
    expect((await db.execute(taskStartsHeld(w.tenant_id))).rows).toHaveLength(0);
    expect((await taskAudit(w, task, "task.admission.changed")).map((row) => row.result)).toEqual([
      "denied",
      "success",
    ]);
  }, 180_000);

  test("an unconfirmed result does not block the next start, a waiting run does", async () => {
    const w = await workspace();
    const task = await scheduled(w, daily);
    await grant(w, task);
    expect(await sweep(w, "2027-03-27T07:00:00.000Z")).toHaveLength(1);
    await settle(w, task, "result_ready");
    expect(await sweep(w, "2027-03-28T06:00:00.000Z")).toHaveLength(1);
    const [, second] = await runs(w, task);
    await db.insert(conversationElicitations).values({
      tenant_id: w.tenant_id,
      conversation_id: second?.conversation_id ?? "",
      tool_name: "ask_user_text",
      summary: "Which list?",
      input: { question: "Which list?" },
    });
    await settle(w, task, "waiting");
    expect(await sweep(w, "2027-03-29T06:00:00.000Z")).toEqual([]);
    expect(await sweep(w, "2027-03-29T06:10:00.000Z")).toEqual([]);
    expect(await runs(w, task)).toHaveLength(2);
    expect((await taskAudit(w, task, "task.admission.changed")).map((row) => row.reason)).toEqual([
      "previous_run_active",
    ]);
    expect((await hold(w, task))?.reason).toBe("previous_run_active");
  }, 180_000);

  test("a paused task starts nothing and a run that never got its conversation fails", async () => {
    const w = await workspace();
    const task = await scheduled(w, daily);
    await grant(w, task);
    await pauseTask({ tenant_id: w.tenant_id, principal: w.owner, task_id: task.id }, db);
    expect(await sweep(w, "2027-03-27T07:00:00.000Z")).toEqual([]);
    expect(await runs(w, task)).toEqual([]);
    expect(await taskAudit(w, task, "task.admission.changed")).toEqual([]);

    const stalled = await scheduled(w, {});
    const created = at("2027-03-27T07:00:00.000Z");
    await db.insert(taskRuns).values({
      tenant_id: w.tenant_id,
      task_id: stalled.id,
      task_revision: 1,
      fingerprint: stalled.fingerprint,
      trigger: "manual",
      state: "running",
      deadline_at: at("2027-03-27T11:00:00.000Z"),
      trace_id: "a".repeat(32),
      created_at: created,
      updated_at: created,
    });
    await sweep(w, "2027-03-27T07:04:00.000Z");
    expect((await runs(w, stalled))[0]?.state).toBe("running");
    await sweep(w, "2027-03-27T07:06:00.000Z");
    expect((await runs(w, stalled))[0]).toMatchObject({
      state: "failed",
      failure_code: "start_failed",
    });
  }, 180_000);

  test("a start that stopped after its conversation was attached gets no turn and fails", async () => {
    const w = await workspace();
    const task = await scheduled(w, daily);
    await grant(w, task);
    await sweep(w, "2027-03-27T07:00:00.000Z");
    const [run] = await runs(w, task);
    if (!run?.conversation_id) throw new Error("the run has no conversation");
    const conversation = and(
      eq(conversations.tenant_id, w.tenant_id),
      eq(conversations.id, run.conversation_id),
    );
    await db
      .update(conversations)
      .set({ playbook: null, playbook_revision: 0, loaded_skills: [] })
      .where(conversation);
    expect(await sweep(w, "2027-03-27T07:04:00.000Z")).not.toContain(run.id);
    expect((await runs(w, task))[0]?.state).toBe("running");
    expect(await sweep(w, "2027-03-27T07:06:00.000Z")).not.toContain(run.id);
    expect((await runs(w, task))[0]).toMatchObject({
      state: "failed",
      failure_code: "start_failed",
    });
    const [closed] = await db
      .select({ status: conversations.status })
      .from(conversations)
      .where(conversation);
    expect(closed?.status).toBe("abandoned");
  }, 180_000);

  test("a hold never outlives a schedule change and never replaces the due check", async () => {
    const w = await workspace();
    const task = await scheduled(w, daily);
    expect(await sweep(w, "2027-03-27T07:00:00.000Z")).toEqual([]);
    expect((await hold(w, task))?.reason).toBe("grant_required");
    await db
      .update(tasks)
      .set({ updated_at: at("2027-03-27T07:30:00.000Z") })
      .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
    const { deps } = clock(at("2027-03-27T08:00:00.000Z"));
    const moved = await updateTask(
      {
        tenant_id: w.tenant_id,
        principal: w.owner,
        task_id: task.id,
        input: {
          ...taskInput({ schedule_cron: "0 18 * * *", schedule_timezone: "Europe/Berlin" }),
          expected_revision: task.revision,
        },
      },
      db,
      deps,
    );
    expect(moved.schedule_changed).toBe(true);
    expect(await hold(w, task)).toEqual({ reason: null, since: null });
    await db
      .update(tasks)
      .set({ updated_at: at("2027-03-27T08:00:00.000Z") })
      .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
    await grant(w, moved.task);
    expect(await sweep(w, "2027-03-27T08:05:00.000Z")).toEqual([]);
    expect(await sweep(w, "2027-03-27T16:59:00.000Z")).toEqual([]);
    expect(await runs(w, task)).toEqual([]);
    expect(await sweep(w, "2027-03-27T17:00:00.000Z")).toHaveLength(1);

    const once = await scheduled(w, { schedule_run_at: "2027-03-26T13:00:00.000Z" });
    expect(await sweep(w, "2027-03-26T13:00:00.000Z")).not.toContain(once.id);
    expect(await hold(w, once)).toEqual({
      reason: "grant_required",
      since: at("2027-03-26T13:00:00.000Z"),
    });
    const later = await updateTask(
      {
        tenant_id: w.tenant_id,
        principal: w.owner,
        task_id: once.id,
        input: {
          ...taskInput({ schedule_run_at: "2027-03-30T09:00:00.000Z" }),
          expected_revision: once.revision,
        },
      },
      db,
      clock(at("2027-03-26T14:00:00.000Z")).deps,
    );
    await grant(w, later.task);
    await sweep(w, "2027-03-29T09:00:00.000Z");
    expect(await runs(w, once)).toEqual([]);
    await sweep(w, "2027-03-30T09:00:00.000Z");
    expect((await runs(w, once)).map((run) => run.trigger)).toEqual(["once"]);
  }, 180_000);

  test("a held task writes nothing while its reason stays the same and survives an unrelated edit", async () => {
    const w = await workspace();
    const task = await scheduled(w, daily);
    await sweep(w, "2027-03-27T07:00:30.000Z");
    const stored = async () =>
      (
        await db
          .select({
            last_claimed_at: tasks.last_claimed_at,
            since: tasks.admission_hold_since,
            xmin: sql<string>`${tasks}.xmin::text`,
          })
          .from(tasks)
          .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)))
      )[0];
    const first = await stored();
    expect(first).toMatchObject({
      last_claimed_at: null,
      since: at("2027-03-27T07:00:00.000Z"),
    });
    const counted = () =>
      JSON.stringify(
        getMetrics()
          .snapshot()
          .filter((series) => series.name.startsWith("subkit_task_")),
      );
    const before = counted();
    expect(before).toContain("held");
    await sweep(w, "2027-03-27T07:01:30.000Z");
    await sweep(w, "2027-03-27T07:02:30.000Z");
    expect(await stored()).toEqual(first);
    expect(counted()).toBe(before);
    await db
      .update(tasks)
      .set({ name: "Renamed", updated_at: at("2027-03-27T07:30:00.000Z") })
      .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
    await grant(w, task);
    expect(await sweep(w, "2027-03-27T07:31:00.000Z")).toHaveLength(1);
  }, 180_000);

  test("a start that fails after its run was created is not tried again", async () => {
    const w = await workspace();
    const task = await scheduled(w, daily);
    await db.insert(taskGrants).values({
      tenant_id: w.tenant_id,
      task_id: task.id,
      fingerprint: task.fingerprint,
      environment: task.environment,
      valid_from: at("2026-01-01T00:00:00.000Z"),
      max_runs: 5,
      created_by: w.owner.id,
    });
    await db
      .update(tasks)
      .set({ plan: { broken: true } })
      .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
    for (const tick of ["07:00", "07:01", "07:02"])
      expect(await sweep(w, `2027-03-27T${tick}:00.000Z`)).toEqual([]);
    const created = await runs(w, task);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ state: "failed", failure_code: "start_failed" });
    const [used] = await db
      .select({ reserved_runs: taskGrants.reserved_runs })
      .from(taskGrants)
      .where(and(eq(taskGrants.tenant_id, w.tenant_id), eq(taskGrants.task_id, task.id)));
    expect(used?.reserved_runs).toBe(1);
    expect(await taskAudit(w, task, "task.schedule_claimed")).toHaveLength(1);
    expect(await sweep(w, "2027-03-28T06:00:00.000Z")).toEqual([]);
    expect(await runs(w, task)).toHaveLength(2);
  }, 180_000);

  test("every run starts with the working skill when the workspace has it", async () => {
    const w = await workspace();
    const loaded = async (task: Task) => {
      const [run] = await runs(w, task);
      const [row] = await db
        .select({ loaded_skills: conversations.loaded_skills })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenant_id, w.tenant_id),
            eq(conversations.id, run?.conversation_id ?? ""),
          ),
        );
      return (row?.loaded_skills ?? []).map((entry) => entry.slug);
    };
    const without = await scheduled(w, daily);
    await grant(w, without);
    await sweep(w, "2027-03-27T07:00:00.000Z");
    expect(await loaded(without)).not.toContain(TASK_RUN_SEED_SKILL);
    await createSkill(
      {
        tenant_id: w.tenant_id,
        slug: TASK_RUN_SEED_SKILL,
        input: { scope: "global", title: "Working on a task", body: "Keep the plan current." },
      },
      db,
    );
    const withSkill = await scheduled(w, daily);
    await grant(w, withSkill);
    await sweep(w, "2027-03-27T07:00:00.000Z");
    expect(await loaded(withSkill)).toContain(TASK_RUN_SEED_SKILL);
    expect(TASK_RUN_SEED_SKILL).toBe("working-on-a-task");
  }, 180_000);

  test("a chat answer on a result that nobody observed is picked up by the sweep", async () => {
    const w = await workspace();
    const task = await scheduled(w, daily);
    await grant(w, task);
    await sweep(w, "2027-03-27T07:00:00.000Z");
    const [run] = await runs(w, task);
    const ready = at("2027-03-27T07:10:00.000Z");
    await db
      .update(taskRuns)
      .set({ state: "result_ready", result_ready_at: ready })
      .where(and(eq(taskRuns.tenant_id, w.tenant_id), eq(taskRuns.id, run?.id ?? "")));
    const { deps, enqueued } = clock(at("2027-03-27T07:20:00.000Z"));
    await sweepTenantTasks(db, w.tenant_id, at("2027-03-27T07:20:00.000Z"), deps);
    expect((await runs(w, task))[0]?.last_seen_turn_id).toBeNull();
    const [turn] = await db
      .insert(conversationTurns)
      .values({
        tenant_id: w.tenant_id,
        conversation_id: run?.conversation_id ?? "",
        state: "completed",
        created_at: at("2027-03-27T07:15:00.000Z"),
      })
      .returning({ id: conversationTurns.id });
    await sweepTenantTasks(db, w.tenant_id, at("2027-03-27T07:21:00.000Z"), deps);
    expect((await runs(w, task))[0]).toMatchObject({
      state: "result_ready",
      last_seen_turn_id: turn?.id,
      last_seen_turn_seq: 1,
    });
    expect(enqueued).toEqual([]);
  }, 180_000);

  test("an edit, a pause or a resume does not move a never-started schedule past a due start", async () => {
    const w = await workspace();
    const task = await scheduled(w, daily);
    await grant(w, task);
    const touch = (iso: string, name: string) =>
      db
        .update(tasks)
        .set({ name, updated_at: at(iso) })
        .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
    await touch("2027-03-27T06:30:00.000Z", "Renamed before the start");
    const ref = { tenant_id: w.tenant_id, principal: w.owner, task_id: task.id };
    await pauseTask(ref, db, clock(at("2027-03-27T06:40:00.000Z")).deps);
    expect(await sweep(w, "2027-03-27T07:00:00.000Z")).toEqual([]);
    await resumeTask(ref, db, clock(at("2027-03-27T07:20:00.000Z")).deps);
    await touch("2027-03-27T07:25:00.000Z", "Renamed after the start");
    const [view] = await withTaskListView(
      db,
      w.tenant_id,
      [await storedTask(w, task)],
      at("2027-03-27T07:26:00.000Z"),
    );
    expect(view?.next_start_at).toBe("2027-03-27T07:00:00.000Z");
    expect(await sweep(w, "2027-03-27T07:30:00.000Z")).toHaveLength(1);
    expect((await runs(w, task)).map((run) => run.trigger)).toEqual(["cron"]);
  }, 180_000);
});
