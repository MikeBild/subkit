import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { conversationMessages, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getTaskRunCheck, getTaskRunMarker } from "../core/draft.ts";
import type { TaskRunMarker } from "../types.ts";
import { createConversation } from "./create.ts";
import { forkConversation } from "./fork.ts";

let ctx: TestDb;
let tenant_id: string;

const marker: TaskRunMarker = {
  task_id: "44444444-5555-4666-8777-888888888888",
  task_run_id: "55555555-6666-4777-8888-999999999999",
  environment: "prod",
  workflow_ids: ["22222222-3333-4444-8555-666666666666"],
  connector_ids: ["66666666-7777-4888-8999-aaaaaaaaaaaa"],
  web_search: false,
};

beforeAll(async () => {
  ctx = await createTestDb("task_run_marker");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-task-run-marker", display_name: "Task run marker" })
    .returning();
  if (!tenant) throw new Error("tenant fixture missing");
  tenant_id = tenant.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function storedDraft(conversation_id: string): Promise<unknown> {
  const [row] = await ctx.db
    .select({ draft: conversations.draft })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)));
  return row?.draft;
}

describe("task run marker on a conversation", () => {
  test("a run conversation stores the marker in its draft session", async () => {
    const created = await createConversation(
      { tenant_id, actor_id: null, task_run: marker },
      ctx.db,
    );
    const draft = await storedDraft(created.conversation.id);
    expect(getTaskRunMarker(draft)).toEqual(marker);
    expect((draft as { session?: unknown }).session).toEqual({
      permission_mode: "auto",
      task_run: marker,
    });
  });

  test("an ordinary conversation carries no marker", async () => {
    const created = await createConversation({ tenant_id, actor_id: null }, ctx.db);
    expect(getTaskRunMarker(await storedDraft(created.conversation.id))).toBeNull();
    const explicit = await createConversation(
      { tenant_id, actor_id: null, task_run: null },
      ctx.db,
    );
    expect(getTaskRunMarker(await storedDraft(explicit.conversation.id))).toBeNull();
  });

  test("a marker that does not validate refuses to create the conversation", async () => {
    const before = await ctx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.tenant_id, tenant_id));
    for (const broken of [
      { ...marker, task_id: "task" },
      { ...marker, task_run_id: "run" },
      { ...marker, environment: "staging" },
      { ...marker, sealed: true },
      {},
      "marker",
      false,
      0,
    ])
      await expect(
        createConversation(
          { tenant_id, actor_id: null, task_run: broken as unknown as TaskRunMarker },
          ctx.db,
        ),
      ).rejects.toMatchObject({ code: "task_run_marker_invalid" });
    const after = await ctx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.tenant_id, tenant_id));
    expect(after).toHaveLength(before.length);
  });

  test("the stored marker is the normalized one, without surplus keys", async () => {
    const created = await createConversation(
      {
        tenant_id,
        actor_id: null,
        task_run: { ...marker, owner_id: marker.task_id } as TaskRunMarker,
      },
      ctx.db,
    );
    const draft = await storedDraft(created.conversation.id);
    expect((draft as { session?: unknown }).session).toEqual({
      permission_mode: "auto",
      task_run: marker,
    });
  });

  test("a stored marker that was damaged afterwards reads as sealed, not as unmarked", async () => {
    const created = await createConversation(
      { tenant_id, actor_id: null, task_run: marker },
      ctx.db,
    );
    await ctx.db
      .update(conversations)
      .set({
        draft: sql`jsonb_set(${conversations.draft}, '{session,task_run,task_id}', '"broken"')`,
      })
      .where(
        and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, created.conversation.id)),
      );
    const read = getTaskRunMarker(await storedDraft(created.conversation.id));
    expect(read).toEqual({
      task_id: "00000000-0000-0000-0000-000000000000",
      task_run_id: "00000000-0000-0000-0000-000000000000",
      environment: "dev",
      workflow_ids: [],
      connector_ids: [],
      web_search: false,
      sealed: true,
    });
  });

  test("forking removes the requested check time together with the marker", async () => {
    const created = await createConversation(
      { tenant_id, actor_id: null, task_run: marker },
      ctx.db,
    );
    const check = { at: "2026-11-20T08:30:00.000Z", reason: "The export is ready after eight" };
    await ctx.db
      .update(conversations)
      .set({
        draft: sql`jsonb_set(${conversations.draft}, '{session,task_check}', ${JSON.stringify(check)}::jsonb)`,
      })
      .where(
        and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, created.conversation.id)),
      );
    expect(getTaskRunCheck(await storedDraft(created.conversation.id))).toEqual(check);
    const [message] = await ctx.db
      .insert(conversationMessages)
      .values({
        tenant_id,
        conversation_id: created.conversation.id,
        role: "user",
        content: { text: "status" },
      })
      .returning({ id: conversationMessages.id });
    if (!message) throw new Error("message fixture missing");
    const forked = await forkConversation(
      {
        tenant_id,
        source_conversation_id: created.conversation.id,
        anchor_message_id: message.id,
        actor_id: null,
        actor_type: "system",
        request_source: "api",
      },
      ctx.db,
    );
    if (!forked) throw new Error("fork missing");
    expect(((await storedDraft(forked.conversation.id)) as { session?: unknown }).session).toEqual({
      permission_mode: "auto",
    });
  });

  test("forking a run conversation removes the marker and keeps the rest of the session", async () => {
    const created = await createConversation(
      { tenant_id, actor_id: null, task_run: marker, playground: true },
      ctx.db,
    );
    const [message] = await ctx.db
      .insert(conversationMessages)
      .values({
        tenant_id,
        conversation_id: created.conversation.id,
        role: "user",
        content: { text: "status" },
      })
      .returning({ id: conversationMessages.id });
    if (!message) throw new Error("message fixture missing");
    const forked = await forkConversation(
      {
        tenant_id,
        source_conversation_id: created.conversation.id,
        anchor_message_id: message.id,
        actor_id: null,
        actor_type: "system",
        request_source: "api",
      },
      ctx.db,
    );
    if (!forked) throw new Error("fork missing");
    const draft = await storedDraft(forked.conversation.id);
    expect(getTaskRunMarker(draft)).toBeNull();
    expect((draft as { session?: unknown }).session).toEqual({
      permission_mode: "auto",
      playground: true,
    });
    expect(getTaskRunMarker(await storedDraft(created.conversation.id))).toEqual(marker);
  });
});
