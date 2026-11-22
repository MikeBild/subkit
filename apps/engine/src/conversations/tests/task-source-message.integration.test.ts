import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { conversations, roles, tasks, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createEmptyDraftDocument } from "../authoring-state/index.ts";
import { appendMessage, insertToolCall } from "../persistence/index.ts";
import { saveTaskTool } from "../tools/engine-api/writes/save-task.ts";
import type { ToolContext } from "../tools/index.ts";

let db: TestDb;
let tenant_id: string;
let owner: ResolvedPrincipal;

const PLAN = {
  title: "Inbox",
  goal: "Sort the inbox",
  steps: [
    {
      id: "sort",
      label: "Sort the inbox",
      criterion: { kind: "assessment", description: "Inbox is sorted", result: null },
      depends_on: [],
      evidence_ids: [],
      note: null,
      progress: "open",
      next_action: null,
    },
  ],
  cancelled: false,
  completion_step_id: null,
};

beforeAll(async () => {
  db = await createTestDb("task_source_message");
  tenant_id = (await seedTenant(db.db)).id;
  const [role] = await db.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, "member")))
    .limit(1);
  if (!role) throw new Error("member role missing");
  const [user] = await db.db
    .insert(users)
    .values({ tenant_id, email: "owner@task-source.test", role_id: role.id })
    .returning({ id: users.id });
  if (!user) throw new Error("user fixture missing");
  owner = { provider: "session", kind: "user", id: user.id, tenant_id, roles: ["member"] };
}, 120_000);

afterAll(async () => {
  await db.cleanup();
});

async function conversation(): Promise<string> {
  const [row] = await db.db
    .insert(conversations)
    .values({ tenant_id, status: "active", title: "Inbox", owner_id: owner.id })
    .returning({ id: conversations.id });
  if (!row) throw new Error("conversation insert returned no row");
  return row.id;
}

function said(conversation_id: string, text: string): Promise<string> {
  return appendMessage(db.db, tenant_id, conversation_id, "user", { text });
}

function asked(conversation_id: string): Promise<string> {
  return insertToolCall(db.db, {
    tenant_id,
    conversation_id,
    tool: "save_task",
    input: {},
    approval_required: false,
  });
}

async function save(
  conversation_id: string,
  name: string,
  call: { tool_call_id?: string; held_tool_call_id?: string },
): Promise<string> {
  const ctx = {
    db: db.db,
    tenant_id,
    conversation_id,
    actor_id: owner.id,
    principal: owner,
    connector_id: null,
    workflow_id: null,
    getDraft: () => createEmptyDraftDocument(),
    ...call,
  } as unknown as ToolContext;
  const result = await saveTaskTool.execute(ctx, {
    name,
    goal: "Sort the inbox",
    done_when: "Inbox is sorted",
    plan: PLAN,
  });
  if (!result.ok) throw new Error(`save_task failed: ${JSON.stringify(result)}`);
  return (result.data as { task_id: string }).task_id;
}

async function sourceOf(task_id: string) {
  const [row] = await db.db
    .select({
      conversation_id: tasks.source_conversation_id,
      message_id: tasks.source_message_id,
    })
    .from(tasks)
    .where(and(eq(tasks.tenant_id, tenant_id), eq(tasks.id, task_id)));
  return row;
}

describe("a task created in chat is bound to the message it serves", () => {
  test("two messages sent during one turn create two tasks, each bound to its own message", async () => {
    const id = await conversation();
    const first = await said(id, "Sort my inbox every morning");
    const firstCall = await asked(id);
    const second = await said(id, "And send me the weekly report");
    const secondCall = await asked(id);
    const sorting = await save(id, "Inbox", { tool_call_id: firstCall });
    const reporting = await save(id, "Report", { tool_call_id: secondCall });
    expect(await sourceOf(sorting)).toEqual({ conversation_id: id, message_id: first });
    expect(await sourceOf(reporting)).toEqual({ conversation_id: id, message_id: second });
  });

  test("a task confirmed after the person typed something else keeps its original message", async () => {
    const id = await conversation();
    const asking = await said(id, "Sort my inbox every morning");
    const held = await asked(id);
    await said(id, "What else can you do?");
    const task = await save(id, "Inbox", { held_tool_call_id: held });
    expect(await sourceOf(task)).toEqual({ conversation_id: id, message_id: asking });
  });

  test("a task without a message from the person has no source", async () => {
    const id = await conversation();
    const task = await save(id, "Inbox", { tool_call_id: await asked(id) });
    expect(await sourceOf(task)).toEqual({ conversation_id: null, message_id: null });
  });

  test("deleting the conversation keeps the task and clears its source", async () => {
    const id = await conversation();
    await said(id, "Sort my inbox every morning");
    const task = await save(id, "Inbox", { tool_call_id: await asked(id) });
    await db.db.delete(conversations).where(eq(conversations.id, id));
    expect(await sourceOf(task)).toEqual({ conversation_id: null, message_id: null });
  });
});
