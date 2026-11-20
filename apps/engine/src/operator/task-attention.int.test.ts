import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { conversations, taskRuns, tasks, users } from "../db/schema/index.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { buildAttention } from "./attention.ts";
import { enduser, owner, tenant_id, testDb, useAttentionTenant } from "./attention-fixtures.ts";
import type { Candidate } from "./attention-readers.ts";
import {
  readTaskAttention,
  type TaskAttentionScope,
  taskAttentionHref,
  taskAttentionScope,
} from "./task-attention.ts";

useAttentionTenant();

const TASK_ID = "44444444-5555-4666-8777-888888888888";

const candidate: Candidate = {
  source: "tasks",
  resource: { type: "task", id: TASK_ID },
  item: {
    id: `task:${TASK_ID}`,
    class: "stopped",
    severity: "urgent",
    kind: "task",
    subject: { kind: "task", id: TASK_ID, name: "Weekly report" },
    reason: "task_run_failed",
    trigger: null,
    cause_class: null,
    counts: {},
    since: null,
    deadline: null,
    detail: null,
    actions: [],
  },
};

let memberPrincipal: ResolvedPrincipal | null = null;

async function member(): Promise<ResolvedPrincipal> {
  if (memberPrincipal) return memberPrincipal;
  const [row] = await testDb.db
    .insert(users)
    .values({
      tenant_id,
      email: "task-attention-member@example.test",
      role_id: await builtinRoleId(testDb.db, "member"),
    })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (!row) throw new Error("member fixture missing");
  memberPrincipal = { provider: "api_key", kind: "user", id: row.id, tenant_id, roles: ["member"] };
  return memberPrincipal;
}

describe("task attention scope", () => {
  test("a principal with the admin role reads every task of the tenant", () => {
    expect(taskAttentionScope(owner)).toEqual({ tenant_id, owner_id: null, viewer_id: owner.id });
    expect(taskAttentionScope({ ...owner, roles: ["member", "admin"] }).owner_id).toBeNull();
  });

  test("everyone else reads own tasks only", () => {
    for (const roles of [["member"], ["enduser"], ["administrator"], []])
      expect(taskAttentionScope({ ...owner, roles })).toEqual({
        tenant_id,
        owner_id: owner.id,
        viewer_id: owner.id,
      });
  });

  test("the reader answers an empty list for a tenant without tasks", async () => {
    const now = new Date(getTestNow());
    expect(await readTaskAttention(testDb.db, taskAttentionScope(owner), now)).toEqual([]);
  });
});

describe("tasks source in attention", () => {
  test("it is read per principal with the caller's own scope, never from the tenant cache", async () => {
    const person = await member();
    const seen: TaskAttentionScope[] = [];
    const task_reader = async (_db: unknown, scope: TaskAttentionScope) => {
      seen.push(scope);
      return scope.owner_id === person.id ? [candidate] : [];
    };
    const mine = await buildAttention(testDb.db, person, { task_reader });
    const admins = await buildAttention(testDb.db, owner, { task_reader });
    expect(seen).toEqual([
      { tenant_id, owner_id: person.id, viewer_id: person.id },
      { tenant_id, owner_id: null, viewer_id: owner.id },
    ]);
    expect(mine.sources.tasks).toBe("answered");
    expect(mine.items.map((item) => item.id)).toContain(candidate.item.id);
    expect(admins.sources.tasks).toBe("answered");
    expect(admins.items.map((item) => item.id)).not.toContain(candidate.item.id);
  });

  test("the reader receives the requested time", async () => {
    const now = new Date("2026-11-19T10:00:00.000Z");
    let received: Date | null = null;
    await buildAttention(testDb.db, owner, {
      now,
      task_reader: async (_db, _scope, at) => {
        received = at;
        return [];
      },
    });
    expect<Date | null>(received).toBe(now);
  });

  test("a principal without task:read never reaches the reader", async () => {
    let calls = 0;
    const attention = await buildAttention(testDb.db, enduser, {
      task_reader: async () => {
        calls += 1;
        return [candidate];
      },
    });
    expect(calls).toBe(0);
    expect(attention.sources.tasks).toBe("not_permitted");
    expect(attention.items.map((item) => item.id)).not.toContain(candidate.item.id);
  });

  test("a failing reader marks only the tasks source as failed", async () => {
    const attention = await buildAttention(testDb.db, owner, {
      task_reader: async () => {
        throw new Error("task reader unavailable");
      },
    });
    expect(attention.sources.tasks).toBe("failed");
    expect(attention.sources.conversations).toBe("answered");
  });

  test("without an override the source answers with no task items", async () => {
    const attention = await buildAttention(testDb.db, owner);
    expect(attention.sources.tasks).toBe("answered");
    expect(attention.items.filter((item) => item.subject?.kind === "task")).toEqual([]);
  });
});

describe("task runs in the composed attention", () => {
  async function seedWaitingRun(person: ResolvedPrincipal) {
    const [task] = await testDb.db
      .insert(tasks)
      .values({
        tenant_id,
        name: "Chase the invoice",
        category: "finance",
        category_source: "human",
        description_source: "human",
        owner_id: person.id,
        goal: "Make sure the confidential invoice is paid",
        done_when: "The payment is booked",
        plan: { title: "Invoice", goal: "Make sure the invoice is paid", steps: [] },
        bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
        environment: "prod",
        fingerprint: "d".repeat(64),
      })
      .returning({ id: tasks.id });
    const [conversation] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id,
        owner_id: person.id,
        status: "awaiting_input",
        title: "Chase the invoice",
        title_locked: true,
      })
      .returning({ id: conversations.id });
    if (!task || !conversation) throw new Error("run fixture missing");
    const [run] = await testDb.db
      .insert(taskRuns)
      .values({
        tenant_id,
        task_id: task.id,
        task_revision: 1,
        fingerprint: "d".repeat(64),
        conversation_id: conversation.id,
        trigger: "manual",
        state: "waiting",
        waiting_reason: "question",
        deadline_at: new Date(getTestNow() + 3_600_000),
        trace_id: "e".repeat(32),
      })
      .returning({ id: taskRuns.id });
    if (!run) throw new Error("run fixture missing");
    return { task_id: task.id, conversation_id: conversation.id, run_id: run.id };
  }

  test("the owner sees one item for a waiting run, and it opens the task", async () => {
    const person = await member();
    const seeded = await seedWaitingRun(person);
    const attention = await buildAttention(testDb.db, person);
    const about = attention.items.filter(
      (item) => item.subject?.id === seeded.task_id || item.subject?.id === seeded.conversation_id,
    );
    expect(about.map((item) => [item.id, item.reason])).toEqual([
      [`conversation:${seeded.conversation_id}`, "awaiting_answer"],
    ]);
    expect(about[0]?.actions.map((action) => action.href)).toEqual([
      taskAttentionHref(seeded.task_id),
    ]);
    expect(JSON.stringify(about)).not.toContain("confidential");
  });

  test("an admin sees the same wait on the task, another member sees nothing", async () => {
    const person = await member();
    const seeded = await seedWaitingRun(person);
    const admins = await buildAttention(testDb.db, owner);
    expect(
      admins.items
        .filter((item) => item.subject?.id === seeded.task_id)
        .map((item) => [item.id, item.reason, item.detail]),
    ).toEqual([[`task:${seeded.task_id}`, "awaiting_answer", "question"]]);
    expect(admins.items.some((item) => item.subject?.id === seeded.conversation_id)).toBe(false);
    const [other] = await testDb.db
      .insert(users)
      .values({
        tenant_id,
        email: "task-attention-colleague@example.test",
        role_id: await builtinRoleId(testDb.db, "member"),
      })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (!other) throw new Error("colleague fixture missing");
    const colleague = await buildAttention(testDb.db, {
      provider: "api_key",
      kind: "user",
      id: other.id,
      tenant_id,
      roles: ["member"],
    });
    expect(
      colleague.items.some(
        (item) =>
          item.subject?.id === seeded.task_id || item.subject?.id === seeded.conversation_id,
      ),
    ).toBe(false);
  });
});
