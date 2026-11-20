import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { conversations, tenants } from "../../db/schema/index.ts";
import { isTaskRunConversation } from "../../db/task-run-conversations.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { listRecentOwnedConversations } from "../../identity/principal-profile.ts";
import { countConversations, createConversation, listConversations } from "../service.ts";
import type { TaskRunMarker } from "../types.ts";

let ctx: TestDb;
let tenant_id = "";
let other_tenant_id = "";
let chatId = "";
let runId = "";
let foreignRunId = "";

const OWNER = "bbbbbbbb-0000-4000-8000-000000000001";

const marker: TaskRunMarker = {
  task_id: "44444444-5555-4666-8777-888888888888",
  task_run_id: "55555555-6666-4777-8888-999999999999",
  environment: "prod",
  workflow_ids: [],
  connector_ids: [],
  web_search: false,
};

beforeAll(async () => {
  ctx = await createTestDb("task_run_conversation_list");
  const [mine, other] = await ctx.db
    .insert(tenants)
    .values([
      { slug: "t-run-list", display_name: "Run list" },
      { slug: "t-run-list-other", display_name: "Run list other" },
    ])
    .returning();
  if (!mine || !other) throw new Error("tenant fixture missing");
  tenant_id = mine.id;
  other_tenant_id = other.id;
  const chat = await createConversation(
    { tenant_id, actor_id: OWNER, title: "Quarterly figures chat" },
    ctx.db,
  );
  const run = await createConversation(
    { tenant_id, actor_id: OWNER, title: "Quarterly figures task", task_run: marker },
    ctx.db,
  );
  const foreign = await createConversation(
    {
      tenant_id: other_tenant_id,
      actor_id: OWNER,
      title: "Quarterly figures elsewhere",
      task_run: marker,
    },
    ctx.db,
  );
  chatId = chat.conversation.id;
  runId = run.conversation.id;
  foreignRunId = foreign.conversation.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

describe("conversation list and task runs", () => {
  test("run conversations are left out by default, from the rows and from the count", async () => {
    expect(ids(await listConversations({ tenant_id }, ctx.db))).toEqual([chatId]);
    expect(await countConversations({ tenant_id }, ctx.db)).toBe(1);
    expect(ids(await listConversations({ tenant_id, task_runs: "exclude" }, ctx.db))).toEqual([
      chatId,
    ]);
  });

  test("the filter lists only run conversations or both", async () => {
    expect(ids(await listConversations({ tenant_id, task_runs: "only" }, ctx.db))).toEqual([runId]);
    expect(await countConversations({ tenant_id, task_runs: "only" }, ctx.db)).toBe(1);
    expect(ids(await listConversations({ tenant_id, task_runs: "all" }, ctx.db))).toEqual(
      [chatId, runId].sort(),
    );
    expect(await countConversations({ tenant_id, task_runs: "all" }, ctx.db)).toBe(2);
  });

  test("search does not find a run conversation unless asked to", async () => {
    expect(ids(await listConversations({ tenant_id, q: "Quarterly figures" }, ctx.db))).toEqual([
      chatId,
    ]);
    expect(
      ids(await listConversations({ tenant_id, q: "Quarterly figures", task_runs: "all" }, ctx.db)),
    ).toEqual([chatId, runId].sort());
  });

  test("another tenant's run conversation never appears under any filter", async () => {
    for (const task_runs of ["exclude", "only", "all"] as const)
      expect(ids(await listConversations({ tenant_id, task_runs }, ctx.db))).not.toContain(
        foreignRunId,
      );
    expect(
      ids(await listConversations({ tenant_id: other_tenant_id, task_runs: "only" }, ctx.db)),
    ).toEqual([foreignRunId]);
  });

  test("a person's recent conversations leave run conversations out", async () => {
    const recent = await listRecentOwnedConversations(ctx.db, tenant_id, OWNER);
    expect(recent.map((row) => row.id)).toEqual([chatId]);
  });

  test("a run conversation keeps the task's name: its title is locked", async () => {
    const [row] = await ctx.db
      .select({ title: conversations.title, title_locked: conversations.title_locked })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, runId)));
    expect(row).toEqual({ title: "Quarterly figures task", title_locked: true });
  });
});

describe("task run predicate", () => {
  async function classified(draft: unknown): Promise<boolean> {
    const [row] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active", draft })
      .returning({ id: conversations.id });
    if (!row) throw new Error("conversation fixture missing");
    const [found] = await ctx.db
      .select({ run: sql<boolean>`${isTaskRunConversation()}` })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, row.id)));
    await ctx.db
      .delete(conversations)
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, row.id)));
    return found?.run === true;
  }

  test("any stored marker key counts, also one that does not validate", async () => {
    expect(await classified({ session: { task_run: marker } })).toBe(true);
    expect(await classified({ session: { task_run: "broken" } })).toBe(true);
    expect(await classified({ session: { task_run: null } })).toBe(true);
  });

  test("drafts without the key do not count", async () => {
    expect(await classified(null)).toBe(false);
    expect(await classified({})).toBe(false);
    expect(await classified({ session: { permission_mode: "auto" } })).toBe(false);
    expect(await classified({ session: "task_run" })).toBe(false);
    expect(await classified({ session: ["task_run"] })).toBe(false);
    expect(await classified({ task_run: marker })).toBe(false);
  });
});
