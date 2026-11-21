import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import {
  auditLog,
  conversationToolCalls,
  taskRuns,
  tasks,
  users,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { createTask, updateTask } from "../../../tasks/index.ts";
import type { TaskCreateInput } from "../../../tasks/types.ts";
import { seedConversation, seedTenant } from "../../../test-helpers/seed.ts";
import { contentHash } from "../../approval-rules/scope.ts";
import { decideRule, noteApprovedAction } from "../../approval-rules/store.ts";
import { describeBoundAction } from "../bound-action.ts";
import { collectContent } from "../content.ts";
import { type PersonCoverInput, recordPersonCover, resolvePersonCover } from "../gate.ts";

let tdb: TestDb;
let tenant_id = "";
let user_id = "";
const NOW = new Date("2026-11-20T10:00:00Z");

beforeAll(async () => {
  tdb = await createTestDb("instruction-cover-task");
  tenant_id = (await seedTenant(tdb.db, { slug: "cover-task", timezone: "Europe/Berlin" })).id;
  const [row] = await tdb.db
    .insert(users)
    .values({
      tenant_id,
      email: "task-owner@example.test",
      role_id: await builtinRoleId(tdb.db, "member"),
    })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  user_id = row.id;
}, 120_000);

afterAll(async () => {
  await tdb?.cleanup();
}, 30_000);

async function toolCall(conversation_id: string): Promise<string> {
  const [row] = await tdb.db
    .insert(conversationToolCalls)
    .values({ tenant_id, conversation_id, tool: "call_connector", input: {}, output: null })
    .returning({ id: conversationToolCalls.id });
  if (!row) throw new Error("tool call fixture missing");
  return row.id;
}

describe("a task's stored goal covers the steps of its own run", () => {
  async function taskRun(p: {
    goal: string;
    started_by: string | null;
    deadline_at?: Date;
  }): Promise<{
    conversation_id: string;
    task_id: string;
    task_run_id: string;
    owner: ResolvedPrincipal;
  }> {
    const [task] = await tdb.db
      .insert(tasks)
      .values({
        tenant_id,
        name: "Weekly report",
        owner_id: user_id,
        goal: p.goal,
        done_when: "The report is sent.",
        goal_edited_by: user_id,
        plan: { title: "Weekly report", goal: p.goal, steps: [] },
        bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
        environment: "prod",
        fingerprint: "c".repeat(64),
      })
      .returning({ id: tasks.id });
    const conversation = await seedConversation(tdb.db, { tenant_id, owner_id: user_id });
    if (!task) throw new Error("task fixture missing");
    const [run] = await tdb.db
      .insert(taskRuns)
      .values({
        tenant_id,
        task_id: task.id,
        task_revision: 1,
        fingerprint: "c".repeat(64),
        conversation_id: conversation.id,
        trigger: p.started_by === null ? "cron" : "manual",
        started_by: p.started_by,
        state: "running",
        deadline_at: p.deadline_at ?? new Date(NOW.getTime() + 3_600_000),
        trace_id: "d".repeat(32),
      })
      .returning({ id: taskRuns.id });
    if (!run) throw new Error("task run fixture missing");
    const owner: ResolvedPrincipal = {
      provider: "task",
      kind: "user",
      id: user_id,
      tenant_id,
      roles: ["member"],
      auth_source: { kind: "task_run", task_id: task.id, task_run_id: run.id, grant_id: null },
    };
    return { conversation_id: conversation.id, task_id: task.id, task_run_id: run.id, owner };
  }

  const GOAL = "Schick jeden Montag die Zusammenfassung an anna@firma.de";
  const ARGS = {
    connector_id: "mail",
    method: "POST",
    path: "/v1/messages/send",
    body: { to: "anna@firma.de", subject: "Zusammenfassung", text: "Die Zusammenfassung." },
  };

  function taskInput(
    run: Awaited<ReturnType<typeof taskRun>>,
    extra: Partial<PersonCoverInput> = {},
  ): PersonCoverInput {
    return {
      db: tdb.db,
      tenant_id,
      conversation_id: run.conversation_id,
      ask_before_writing: false,
      tool: "call_connector",
      now: NOW,
      principal: run.owner,
      surface: "web",
      task_run: true,
      task_run_id: run.task_run_id,
      args: ARGS,
      because: GOAL,
      ...extra,
    };
  }

  test("the owner's scheduled run is covered once per run and records the job", async () => {
    const run = await taskRun({ goal: GOAL, started_by: null });
    const cover = await resolvePersonCover(taskInput(run));
    expect(cover.instruction_covered).toBe(true);
    expect(cover.record).toMatchObject({
      rule: "user_instruction",
      because: { quote: GOAL, message_id: null },
      job_id: run.task_run_id,
    });
    const tool_call_id = await toolCall(run.conversation_id);
    await recordPersonCover({
      db: tdb.db,
      tenant_id,
      conversation_id: run.conversation_id,
      tool_call_id,
      tool: "call_connector",
      actor_id: user_id,
      cover,
      resolved_rule: "user_instruction",
      proceeded: true,
    });
    const [audited] = await tdb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, "tool_policy.confirmation_skipped"),
          sql`${auditLog.metadata} ->> 'tool_call_id' = ${tool_call_id}`,
        ),
      );
    expect(audited?.metadata).toMatchObject({ tool_call_id, job_id: run.task_run_id });
    const again = await resolvePersonCover(taskInput(run));
    expect(again.record?.ask_reason).toBe("already_used");
  });

  test("another recipient, another run, someone else's start and an expired run ask", async () => {
    const own = await taskRun({ goal: GOAL, started_by: user_id });
    const other = await resolvePersonCover(
      taskInput(own, { args: { ...ARGS, body: { ...ARGS.body, to: "bob@firma.de" } } }),
    );
    expect(other.record?.ask_reason).toBe("recipient_not_named");
    const elsewhere = await resolvePersonCover(
      taskInput(own, { task_run_id: "00000000-0000-4000-8000-0000000000ff" }),
    );
    expect(elsewhere.record?.ask_reason).toBe("write_gate");
    const someone = await taskRun({
      goal: GOAL,
      started_by: "00000000-0000-4000-8000-000000000abc",
    });
    const started = await resolvePersonCover(taskInput(someone));
    expect(started.record?.ask_reason).toBe("not_started_by_person");
    const late = await taskRun({
      goal: GOAL,
      started_by: null,
      deadline_at: new Date(NOW.getTime() - 1),
    });
    const expired = await resolvePersonCover(taskInput(late));
    expect(expired.record?.ask_reason).toBe("job_expired");
    for (const cover of [other, elsewhere, started, expired]) {
      expect(cover.instruction_covered).toBe(false);
    }
  });
  test("a goal edited after the run started covers nothing", async () => {
    const run = await taskRun({ goal: GOAL, started_by: null });
    await tdb.db.update(tasks).set({ revision: 2 }).where(eq(tasks.id, run.task_id));
    const cover = await resolvePersonCover(taskInput(run));
    expect(cover.instruction_covered).toBe(false);
    expect(cover.record?.ask_reason).toBe("write_gate");
  });

  test("the owner's saved rule covers in the owner's run, not in a run someone else started", async () => {
    const owner = { tenant_id, user_id };
    const args = {
      ...ARGS,
      body: { to: "kunde@example.com", subject: "Status", text: "Alles erledigt." },
    };
    const action = describeBoundAction("call_connector", args, ["kunde@example.com"]);
    const approved = contentHash(collectContent("call_connector", args));
    await noteApprovedAction(tdb.db, owner, action, approved);
    const offer = await noteApprovedAction(tdb.db, owner, action, approved);
    if (!offer) throw new Error("offer missing");
    await decideRule(tdb.db, owner, offer.rule_id, "accept", NOW);
    const own = await taskRun({ goal: "Prüfe die offenen Tickets", started_by: null });
    const covered = await resolvePersonCover(taskInput(own, { args, because: null }));
    expect(covered.rule_covered).toBe(true);
    expect(covered.record).toMatchObject({ rule: "standing_rule", job_id: own.task_run_id });
    const other = await taskRun({
      goal: "Prüfe die offenen Tickets",
      started_by: "00000000-0000-4000-8000-000000000abc",
    });
    const asked = await resolvePersonCover(taskInput(other, { args, because: null }));
    expect([asked.rule_covered, asked.instruction_covered]).toEqual([false, false]);
  });
});

describe("only the owner's own goal gives cover", () => {
  const GOAL = "Schick jeden Montag die Zusammenfassung an anna@firma.de";
  const DONE = "Anna hat die Zusammenfassung.";
  const ARGS = {
    connector_id: "mail",
    method: "POST",
    path: "/v1/messages/send",
    body: { to: "anna@firma.de", subject: "Zusammenfassung", text: "Die Zusammenfassung." },
  };
  const deps = { now: () => NOW };
  let admin: ResolvedPrincipal;
  let person: ResolvedPrincipal;

  beforeAll(async () => {
    const [row] = await tdb.db
      .insert(users)
      .values({
        tenant_id,
        email: "task-admin@example.test",
        role_id: await builtinRoleId(tdb.db, "admin"),
      })
      .returning({ id: users.id });
    if (!row) throw new Error("admin fixture missing");
    admin = { provider: "session", kind: "user", id: row.id, tenant_id, roles: ["admin"] };
    person = { provider: "session", kind: "user", id: user_id, tenant_id, roles: ["member"] };
  });

  function definition(goal: string, done_when: string): TaskCreateInput {
    return {
      name: "Monday summary",
      description: null,
      goal,
      done_when,
      plan: {
        title: "Monday summary",
        goal,
        steps: [
          {
            id: "send",
            label: "Send the summary",
            criterion: { kind: "assessment", description: "Anna has it", result: null },
            depends_on: [],
            evidence_ids: [],
            note: null,
            progress: "open",
            next_action: null,
          },
        ],
        cancelled: false,
        completion_step_id: null,
      },
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      schedule_cron: null,
      schedule_timezone: null,
      schedule_run_at: null,
      max_turns: 20,
      run_deadline_minutes: 240,
    };
  }

  async function runCover(
    task_id: string,
  ): Promise<Awaited<ReturnType<typeof resolvePersonCover>>> {
    const [task] = await tdb.db
      .select({ revision: tasks.revision, fingerprint: tasks.fingerprint })
      .from(tasks)
      .where(eq(tasks.id, task_id));
    if (!task) throw new Error("task missing");
    const conversation = await seedConversation(tdb.db, { tenant_id, owner_id: user_id });
    const [run] = await tdb.db
      .insert(taskRuns)
      .values({
        tenant_id,
        task_id,
        task_revision: task.revision,
        fingerprint: task.fingerprint,
        conversation_id: conversation.id,
        trigger: "cron",
        started_by: null,
        state: "completed",
        deadline_at: new Date(NOW.getTime() + 3_600_000),
        trace_id: "e".repeat(32),
      })
      .returning({ id: taskRuns.id });
    if (!run) throw new Error("task run fixture missing");
    return await resolvePersonCover({
      db: tdb.db,
      tenant_id,
      conversation_id: conversation.id,
      ask_before_writing: false,
      tool: "call_connector",
      now: NOW,
      principal: {
        ...person,
        provider: "task",
        auth_source: { kind: "task_run", task_id, task_run_id: run.id, grant_id: null },
      },
      surface: "web",
      task_run: true,
      task_run_id: run.id,
      args: ARGS,
      because: GOAL,
    });
  }

  async function editor(task_id: string): Promise<string | null> {
    const [row] = await tdb.db
      .select({ goal_edited_by: tasks.goal_edited_by })
      .from(tasks)
      .where(eq(tasks.id, task_id));
    return row?.goal_edited_by ?? null;
  }

  test("the owner's goal covers, an admin's edit asks, the owner's re-edit covers again", async () => {
    const created = await createTask(
      { tenant_id, principal: person, input: definition(GOAL, DONE) },
      tdb.db,
      deps,
    );
    expect(await editor(created.id)).toBe(user_id);
    const own = await runCover(created.id);
    expect(own.instruction_covered).toBe(true);
    expect(own.record?.rule).toBe("user_instruction");

    const byAdmin = await updateTask(
      {
        tenant_id,
        principal: admin,
        task_id: created.id,
        input: { ...definition(GOAL, "Anna und Bob haben sie."), expected_revision: 1 },
      },
      tdb.db,
      deps,
    );
    expect(await editor(created.id)).toBe(admin.id);
    const asked = await runCover(created.id);
    expect(asked.instruction_covered).toBe(false);
    expect(asked.rule_covered).toBe(false);
    expect(asked.record).toMatchObject({
      ran_without_asking: false,
      rule: null,
      ask_reason: "no_user_message",
    });

    await updateTask(
      {
        tenant_id,
        principal: person,
        task_id: created.id,
        input: { ...definition(GOAL, DONE), expected_revision: byAdmin.task.revision },
      },
      tdb.db,
      deps,
    );
    expect(await editor(created.id)).toBe(user_id);
    const again = await runCover(created.id);
    expect(again.instruction_covered).toBe(true);
    expect(again.record?.rule).toBe("user_instruction");
  });

  test("an admin who changes only the limits leaves the owner's goal in place", async () => {
    const created = await createTask(
      { tenant_id, principal: person, input: definition(GOAL, DONE) },
      tdb.db,
      deps,
    );
    await updateTask(
      {
        tenant_id,
        principal: admin,
        task_id: created.id,
        input: { ...definition(GOAL, DONE), max_turns: 5, expected_revision: 1 },
      },
      tdb.db,
      deps,
    );
    expect(await editor(created.id)).toBe(user_id);
    expect((await runCover(created.id)).instruction_covered).toBe(true);
  });

  test("a goal the run itself rewrote is nobody's words", async () => {
    const created = await createTask(
      { tenant_id, principal: person, input: definition(GOAL, DONE) },
      tdb.db,
      deps,
    );
    await updateTask(
      {
        tenant_id,
        principal: {
          ...person,
          provider: "task",
          auth_source: {
            kind: "task_run",
            task_id: created.id,
            task_run_id: "00000000-0000-4000-8000-0000000000aa",
            grant_id: null,
          },
        },
        task_id: created.id,
        input: { ...definition(`${GOAL} und an bob@firma.de`, DONE), expected_revision: 1 },
      },
      tdb.db,
      deps,
    );
    expect(await editor(created.id)).toBeNull();
    expect((await runCover(created.id)).instruction_covered).toBe(false);
  });
});
