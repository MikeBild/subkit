import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { tasks, users } from "../../db/schema/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../http/errors.ts";
import {
  countTasks,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  pauseTask,
  pauseTasksOfOwner,
  resumeTask,
  SYSTEM_SCOPE,
  type TaskPrincipal,
  taskFingerprint,
  updateTask,
} from "../index.ts";
import {
  auditRows,
  changeEvents,
  ctx,
  NOW,
  recordingDeps,
  taskInput,
  useTaskDb,
  workspace,
} from "./fixtures.ts";

useTaskDb("tasks_service");

const { deps, seen } = recordingDeps();
const revoked = (task_id: string) =>
  seen.revocations.filter(([id]) => id === task_id).map(([, reason, actor]) => [reason, actor]);

describe("tasks/service definitions", () => {
  test("create stores the task with human metadata, audits and announces it", async () => {
    const w = await workspace();
    const input = taskInput({ description: "Every Monday", category: "reports" });
    const task = await createTask(
      { locale: "de", tenant_id: w.tenant_id, principal: w.owner, input },
      ctx.db,
      deps,
    );
    expect(task).toMatchObject({
      name: "Weekly report",
      description: "Every Monday",
      category: "reports",
      owner_id: w.owner.id,
      revision: 1,
      lifecycle: "active",
      paused_at: null,
      fingerprint: taskFingerprint({ ...input, owner_id: w.owner.id }),
    });
    const [row] = await ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
    expect(row?.description_source).toBe("human");
    expect(row?.category_source).toBe("human");
    const audit = await auditRows(w.tenant_id, task.id);
    expect(audit.map((entry) => [entry.action, entry.actor_type, entry.actor_id])).toEqual([
      ["task.created", "user", w.owner.id],
    ]);
    expect(audit[0]?.metadata).toMatchObject({
      revision: 1,
      environment: "dev",
      owner_id: w.owner.id,
      schedule_kind: "none",
    });
    expect(audit[0]?.after).toEqual({ name: "Weekly report", lifecycle: "active" });
    expect(JSON.stringify(audit[0])).not.toContain("Send the weekly report");
    expect(await changeEvents(w.tenant_id, "task.changed")).toEqual([
      { payload: { task_id: task.id } },
    ]);
  });

  test("a task without description keeps human sources so it is never auto-described", async () => {
    const w = await workspace();
    const task = await createTask(
      { locale: "de", tenant_id: w.tenant_id, principal: w.owner, input: taskInput() },
      ctx.db,
      deps,
    );
    const [row] = await ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
    expect(row).toMatchObject({
      description: null,
      category: "other",
      description_source: "human",
      category_source: "human",
    });
  });

  test("create refuses a schedule under fifteen minutes and a plan without room", async () => {
    const w = await workspace();
    const create = (input: ReturnType<typeof taskInput>) =>
      createTask({ locale: "de", tenant_id: w.tenant_id, principal: w.owner, input }, ctx.db, deps);
    const frequent = await create(taskInput({ schedule_cron: "*/5 * * * *" })).catch((e) => e);
    expect(frequent).toBeInstanceOf(BadRequestError);
    expect(frequent.details).toEqual({ code: "cron_too_frequent" });
    const base = taskInput().plan.steps[0]!;
    const crowded = await create(
      taskInput({
        plan: {
          ...taskInput().plan,
          steps: Array.from({ length: 20 }, (_, index) => ({ ...base, id: `s${index}` })),
        },
      }),
    ).catch((e) => e);
    expect(crowded.details).toEqual({ code: "plan_too_many_steps" });
    const reserved = await create(
      taskInput({
        plan: {
          ...taskInput().plan,
          steps: [base, { ...base, id: "confirm-result", label: "Verify warehouse South" }],
        },
      }),
    ).catch((e) => e);
    expect(reserved).toBeInstanceOf(BadRequestError);
    expect(reserved.details).toEqual({ code: "plan_reserved_step_id" });
    expect(await countTasks({ tenant_id: w.tenant_id, principal: SYSTEM_SCOPE }, ctx.db)).toBe(0);
  });

  test("update bumps the revision and changes the fingerprint only with the content", async () => {
    const w = await workspace();
    const scope = { tenant_id: w.tenant_id, principal: w.owner };
    const created = await createTask({ locale: "de", ...scope, input: taskInput() }, ctx.db, deps);
    const renamed = await updateTask(
      {
        ...scope,
        task_id: created.id,
        input: { ...taskInput({ name: "Report" }), expected_revision: 1 },
      },
      ctx.db,
      deps,
    );
    expect(renamed).toMatchObject({
      task: { name: "Report", revision: 2, fingerprint: created.fingerprint },
      schedule_changed: false,
      grant_invalidated: false,
      aborted_run_id: null,
    });
    expect(revoked(created.id)).toEqual([]);
    const changed = await updateTask(
      {
        ...scope,
        task_id: created.id,
        input: { ...taskInput({ name: "Report", goal: "Send it twice" }), expected_revision: 2 },
      },
      ctx.db,
      deps,
    );
    expect(changed.task.revision).toBe(3);
    expect(changed.task.fingerprint).not.toBe(created.fingerprint);
    expect(changed).toMatchObject({ grant_invalidated: true, aborted_run_id: null });
    expect(revoked(created.id)).toEqual([["task_changed", w.owner.id]]);
    const stale = await updateTask(
      { ...scope, task_id: created.id, input: { ...taskInput(), expected_revision: 2 } },
      ctx.db,
      deps,
    ).catch((e) => e);
    expect(stale).toBeInstanceOf(ConflictError);
    expect(stale.details).toEqual({ expected_revision: 2, current_revision: 3 });
    const audit = (await auditRows(w.tenant_id, created.id)).filter(
      (entry) => entry.action === "task.updated",
    );
    expect(audit.map((entry) => entry.metadata)).toMatchObject([
      { revision: 2, previous_revision: 1, schedule_kind: "none", grant_invalidated: false },
      { revision: 3, previous_revision: 2, environment: "dev", grant_invalidated: true },
    ]);
  });

  test("delete archives the task, audits it and hides it", async () => {
    const w = await workspace();
    const scope = { tenant_id: w.tenant_id, principal: w.owner };
    const task = await createTask({ locale: "de", ...scope, input: taskInput() }, ctx.db, deps);
    await deleteTask({ ...scope, task_id: task.id }, ctx.db, deps);
    expect(revoked(task.id)).toEqual([["task_archived", w.owner.id]]);
    expect(await getTask({ ...scope, task_id: task.id }, ctx.db)).toBeNull();
    expect(await listTasks(scope, ctx.db)).toEqual([]);
    expect(
      (await getTask({ ...scope, task_id: task.id, include_archived: true }, ctx.db))?.lifecycle,
    ).toBe("archived");
    expect((await listTasks({ ...scope, lifecycle: "archived" }, ctx.db)).map((t) => t.id)).toEqual(
      [task.id],
    );
    expect((await auditRows(w.tenant_id, task.id)).map((entry) => entry.action)).toEqual([
      "task.created",
      "task.deleted",
    ]);
    const again = await deleteTask({ ...scope, task_id: task.id }, ctx.db, deps).catch((e) => e);
    expect(again).toBeInstanceOf(NotFoundError);
  });

  test("a person sees and changes only their own tasks, an admin all of them", async () => {
    const w = await workspace();
    const other = await workspace();
    const mine = await createTask(
      { locale: "de", tenant_id: w.tenant_id, principal: w.owner, input: taskInput() },
      ctx.db,
      deps,
    );
    const theirs = await createTask(
      {
        locale: "de",
        tenant_id: w.tenant_id,
        principal: w.member,
        input: taskInput({ name: "Other" }),
      },
      ctx.db,
      deps,
    );
    const ids = async (principal: TaskPrincipal, tenant_id = w.tenant_id) =>
      (await listTasks({ tenant_id, principal, sort: "name" }, ctx.db)).map((task) => task.id);
    expect(await ids(w.owner)).toEqual([mine.id]);
    expect(await ids(w.member)).toEqual([theirs.id]);
    expect(await ids(w.admin)).toEqual([theirs.id, mine.id]);
    expect(await ids(SYSTEM_SCOPE)).toEqual([theirs.id, mine.id]);
    expect(await ids(other.admin, other.tenant_id)).toEqual([]);
    expect(await countTasks({ tenant_id: w.tenant_id, principal: w.owner }, ctx.db)).toBe(1);
    expect(await countTasks({ tenant_id: w.tenant_id, principal: w.admin }, ctx.db)).toBe(2);
    expect(
      await getTask({ tenant_id: w.tenant_id, principal: w.member, task_id: mine.id }, ctx.db),
    ).toBeNull();
    expect(
      await getTask(
        { tenant_id: other.tenant_id, principal: other.admin, task_id: mine.id },
        ctx.db,
      ),
    ).toBeNull();
    expect(
      (await getTask({ tenant_id: w.tenant_id, principal: w.admin, task_id: mine.id }, ctx.db))?.id,
    ).toBe(mine.id);
    const input = { ...taskInput(), expected_revision: 1 };
    for (const attempt of [
      () =>
        updateTask(
          { tenant_id: w.tenant_id, principal: w.member, task_id: mine.id, input },
          ctx.db,
          deps,
        ),
      () =>
        pauseTask({ tenant_id: w.tenant_id, principal: w.member, task_id: mine.id }, ctx.db, deps),
      () =>
        deleteTask({ tenant_id: w.tenant_id, principal: w.member, task_id: mine.id }, ctx.db, deps),
      () =>
        deleteTask(
          { tenant_id: other.tenant_id, principal: other.admin, task_id: mine.id },
          ctx.db,
          deps,
        ),
    ])
      expect(await attempt().catch((e) => e)).toBeInstanceOf(NotFoundError);
    expect(
      (
        await updateTask(
          { tenant_id: w.tenant_id, principal: w.admin, task_id: mine.id, input },
          ctx.db,
          deps,
        )
      ).task.owner_id,
    ).toBe(w.owner.id);
  });

  test("the list filters by search text, owner and category", async () => {
    const w = await workspace();
    const admin = { tenant_id: w.tenant_id, principal: w.admin };
    await createTask(
      { locale: "de", ...admin, principal: w.owner, input: taskInput({ category: "reports" }) },
      ctx.db,
      deps,
    );
    await createTask(
      {
        locale: "de",
        ...admin,
        principal: w.member,
        input: taskInput({ name: "Invoice 100%", goal: "Chase invoices" }),
      },
      ctx.db,
      deps,
    );
    const names = async (filter: Parameters<typeof listTasks>[0]) =>
      (await listTasks(filter, ctx.db)).map((task) => task.name);
    expect(await names({ ...admin, q: "invoice" })).toEqual(["Invoice 100%"]);
    expect(await names({ ...admin, q: "100%" })).toEqual(["Invoice 100%"]);
    expect(await names({ ...admin, q: "%" })).toEqual(["Invoice 100%"]);
    expect(await names({ ...admin, owner_id: w.owner.id })).toEqual(["Weekly report"]);
    expect(await names({ ...admin, category: "reports" })).toEqual(["Weekly report"]);
    expect(await names({ ...admin, sort: "name", order: "desc", limit: 1 })).toEqual([
      "Weekly report",
    ]);
    expect(await names({ ...admin, sort: "name", limit: 1, offset: 1 })).toEqual(["Weekly report"]);
  });

  test("pause and resume record who did it and why", async () => {
    const w = await workspace();
    const scope = { tenant_id: w.tenant_id, principal: w.owner };
    const task = await createTask({ locale: "de", ...scope, input: taskInput() }, ctx.db, deps);
    const paused = await pauseTask({ ...scope, task_id: task.id }, ctx.db, deps);
    expect(paused).toMatchObject({
      paused_at: NOW.toISOString(),
      paused_by: w.owner.id,
      paused_reason: "owner_request",
    });
    expect((await pauseTask({ ...scope, task_id: task.id }, ctx.db, deps)).paused_reason).toBe(
      "owner_request",
    );
    const resumed = await resumeTask({ ...scope, task_id: task.id }, ctx.db, deps);
    expect(resumed).toMatchObject({
      task: { paused_at: null, paused_by: null, paused_reason: null },
      run: null,
      enqueue: false,
    });
    await resumeTask({ ...scope, task_id: task.id }, ctx.db, deps);
    const byAdmin = await pauseTask(
      { ...scope, principal: w.admin, task_id: task.id },
      ctx.db,
      deps,
    );
    expect(byAdmin).toMatchObject({ paused_by: w.admin.id, paused_reason: "admin" });
    expect(
      (await auditRows(w.tenant_id, task.id)).map((entry) => [
        entry.action,
        entry.actor_id,
        entry.reason,
      ]),
    ).toEqual([
      ["task.created", w.owner.id, null],
      ["task.paused", w.owner.id, "owner_request"],
      ["task.resumed", w.owner.id, null],
      ["task.paused", w.admin.id, "admin"],
    ]);
  });

  test("removing the owner pauses all their tasks until a person resumes them", async () => {
    const w = await workspace();
    const scope = { tenant_id: w.tenant_id, principal: w.owner };
    const open = await createTask({ locale: "de", ...scope, input: taskInput() }, ctx.db, deps);
    const paused = await createTask(
      { locale: "de", ...scope, input: taskInput({ name: "Paused" }) },
      ctx.db,
      deps,
    );
    const gone = await createTask(
      { locale: "de", ...scope, input: taskInput({ name: "Gone" }) },
      ctx.db,
      deps,
    );
    const foreign = await createTask(
      { locale: "de", ...scope, principal: w.member, input: taskInput() },
      ctx.db,
      deps,
    );
    await pauseTask({ ...scope, task_id: paused.id }, ctx.db, deps);
    await deleteTask({ ...scope, task_id: gone.id }, ctx.db, deps);
    await ctx.db
      .update(users)
      .set({ status: "disabled" })
      .where(and(eq(users.tenant_id, w.tenant_id), eq(users.id, w.owner.id)));
    const ids = await pauseTasksOfOwner(w.tenant_id, w.owner.id, ctx.db, deps);
    expect([...ids].sort()).toEqual([open.id, paused.id].sort());
    expect(await pauseTasksOfOwner(w.tenant_id, w.owner.id, ctx.db, deps)).toEqual([]);
    expect(revoked(open.id)).toEqual([["owner_unavailable", null]]);
    expect(revoked(paused.id)).toEqual([["owner_unavailable", null]]);
    expect(revoked(foreign.id)).toEqual([]);
    const admin = { tenant_id: w.tenant_id, principal: w.admin };
    for (const id of [open.id, paused.id])
      expect(await getTask({ ...admin, task_id: id }, ctx.db)).toMatchObject({
        paused_reason: "owner_unavailable",
        paused_by: null,
      });
    expect((await getTask({ ...admin, task_id: foreign.id }, ctx.db))?.paused_at).toBeNull();
    const last = (await auditRows(w.tenant_id, open.id)).at(-1);
    expect(last).toMatchObject({
      action: "task.paused",
      actor_type: "system",
      actor_id: null,
      reason: "owner_unavailable",
    });
    expect(
      (await resumeTask({ ...admin, task_id: open.id }, ctx.db, deps)).task.paused_at,
    ).toBeNull();
  });

  test("only a person can own a task", async () => {
    const w = await workspace();
    const machine = { ...w.owner, kind: "system_account" as const };
    const foreign = { ...w.owner, tenant_id: (await workspace()).tenant_id };
    for (const principal of [machine, foreign]) {
      const refused = await createTask(
        { locale: "de", tenant_id: w.tenant_id, principal, input: taskInput() },
        ctx.db,
        deps,
      ).catch((e) => e);
      expect(refused).toBeInstanceOf(ForbiddenError);
    }
    expect(await countTasks({ tenant_id: w.tenant_id, principal: SYSTEM_SCOPE }, ctx.db)).toBe(0);
  });

  test("a missing principal is never treated as the system", async () => {
    const w = await workspace();
    const task = await createTask(
      { locale: "de", tenant_id: w.tenant_id, principal: w.owner, input: taskInput() },
      ctx.db,
      deps,
    );
    const missing = undefined as unknown as TaskPrincipal;
    const read = await getTask(
      { tenant_id: w.tenant_id, principal: missing, task_id: task.id },
      ctx.db,
    ).catch((e) => e);
    expect(read).toBeInstanceOf(ForbiddenError);
    const none = null as unknown as TaskPrincipal;
    const listed = await listTasks({ tenant_id: w.tenant_id, principal: none }, ctx.db).catch(
      (e) => e,
    );
    expect(listed).toBeInstanceOf(ForbiddenError);
  });

  test("a schedule change starts counting anew, other edits leave a fired schedule alone", async () => {
    const w = await workspace();
    const scope = { tenant_id: w.tenant_id, principal: w.owner };
    const later = new Date(NOW.getTime() + 3_600_000).toISOString();
    const past = await createTask(
      { locale: "de", ...scope, input: taskInput({ schedule_run_at: NOW.toISOString() }) },
      ctx.db,
      deps,
    ).catch((e) => e);
    expect(past.details).toEqual({ code: "run_at_past" });
    const task = await createTask(
      { locale: "de", ...scope, input: taskInput({ schedule_run_at: later }) },
      ctx.db,
      deps,
    );
    const claimed = new Date(NOW.getTime() - 60_000);
    await ctx.db
      .update(tasks)
      .set({ last_claimed_at: claimed, schedule_run_at: claimed })
      .where(and(eq(tasks.tenant_id, w.tenant_id), eq(tasks.id, task.id)));
    const fired = { schedule_run_at: claimed.toISOString() };
    const renamed = await updateTask(
      {
        ...scope,
        task_id: task.id,
        input: { ...taskInput({ ...fired, name: "Renamed" }), expected_revision: 1 },
      },
      ctx.db,
      deps,
    );
    expect(renamed.schedule_changed).toBe(false);
    expect(renamed.task.last_claimed_at).toBe(claimed.toISOString());
    const stillPast = await updateTask(
      {
        ...scope,
        task_id: task.id,
        input: {
          ...taskInput({ schedule_run_at: new Date(NOW.getTime() - 1000).toISOString() }),
          expected_revision: 2,
        },
      },
      ctx.db,
      deps,
    ).catch((e) => e);
    expect(stillPast.details).toEqual({ code: "run_at_past" });
    const moved = await updateTask(
      {
        ...scope,
        task_id: task.id,
        input: { ...taskInput({ schedule_cron: "0 8 * * 1" }), expected_revision: 2 },
      },
      ctx.db,
      deps,
    );
    expect(moved).toMatchObject({ schedule_changed: true, grant_invalidated: true });
    expect(moved.task.last_claimed_at).toBeNull();
    expect(moved.task.updated_at).toBe(NOW.toISOString());
    const frequent = await updateTask(
      {
        ...scope,
        task_id: task.id,
        input: { ...taskInput({ schedule_cron: "*/5 * * * *" }), expected_revision: 3 },
      },
      ctx.db,
      deps,
    ).catch((e) => e);
    expect(frequent.details).toEqual({ code: "cron_too_frequent" });
    const rareClosePair = await updateTask(
      {
        ...scope,
        task_id: task.id,
        input: {
          ...taskInput({
            schedule_cron: "0,16,32,50 0,2,4,6,8,10,12,14,16,18,20,23 1,3,5,6 12 *",
          }),
          expected_revision: 3,
        },
      },
      ctx.db,
      deps,
    ).catch((e) => e);
    expect(rareClosePair).toBeInstanceOf(BadRequestError);
    expect(rareClosePair.details).toEqual({ code: "cron_too_frequent" });
    expect((await getTask({ ...scope, task_id: task.id }, ctx.db))?.schedule_cron).toBe(
      "0 8 * * 1",
    );
  });

  test("update and delete record name and lifecycle before and after", async () => {
    const w = await workspace();
    const scope = { tenant_id: w.tenant_id, principal: w.owner };
    const task = await createTask({ locale: "de", ...scope, input: taskInput() }, ctx.db, deps);
    await updateTask(
      {
        ...scope,
        task_id: task.id,
        input: { ...taskInput({ name: "Monthly report" }), expected_revision: 1 },
      },
      ctx.db,
      deps,
    );
    await deleteTask({ ...scope, task_id: task.id }, ctx.db, deps);
    const audit = await auditRows(w.tenant_id, task.id);
    expect(audit.map((entry) => [entry.action, entry.before, entry.after])).toEqual([
      ["task.created", null, { name: "Weekly report", lifecycle: "active" }],
      [
        "task.updated",
        { name: "Weekly report", lifecycle: "active" },
        { name: "Monthly report", lifecycle: "active" },
      ],
      [
        "task.deleted",
        { name: "Monthly report", lifecycle: "active" },
        { name: "Monthly report", lifecycle: "archived" },
      ],
    ]);
    expect(
      audit.every((entry) => (entry.metadata as { task_id?: string }).task_id === task.id),
    ).toBe(true);
  });
});
