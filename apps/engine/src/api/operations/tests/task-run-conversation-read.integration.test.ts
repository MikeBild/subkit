import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { getTool } from "../../../conversations/tools/index.ts";
import { conversationMessages, conversations } from "../../../db/schema/index.ts";
import { readConversationCommit } from "../../../mcp/capabilities/conversation-commit.ts";
import { createTaskWorld, type TaskWorld, taskBody } from "./task-golden-world.ts";

let world: TaskWorld;
let conversationId: string;
let chatId: string;

type Listing = { items: Array<{ id: string }>; total: number };

async function listed(key: string, filter: string): Promise<Listing> {
  const response = await world.http(
    "GET",
    `/v1/conversations?task_runs=${filter}&limit=200`,
    undefined,
    key,
  );
  expect(response.status).toBe(200);
  return response.body as Listing;
}

beforeAll(async () => {
  world = await createTaskWorld("operations_task_run_conversation_read", "task-runs");
  const created = await world.http("POST", "/v1/tasks", taskBody({ name: "Private task" }));
  expect(created.status).toBe(201);
  const started = await world.http("POST", `/v1/tasks/${(created.body as { id: string }).id}/runs`);
  expect(started.status).toBe(201);
  conversationId = (started.body as { conversation_id: string }).conversation_id;
  const chat = await world.http("POST", "/v1/conversations", { title: "Chat to share" });
  expect(chat.status).toBe(201);
  chatId = (chat.body as { conversation: { id: string } }).conversation.id;
}, 120_000);

afterAll(async () => {
  await world.cleanup();
});

const READS = ["", "/tool-policies", "/attachments", "/context-snapshot"];

describe("reading the conversation of a task run", () => {
  test("the owner and an admin read it on every read route", async () => {
    for (const person of [world.owner, world.admin])
      for (const suffix of READS) {
        const response = await world.http(
          "GET",
          `/v1/conversations/${conversationId}${suffix}`,
          undefined,
          person.key,
        );
        expect([suffix, response.status]).toEqual([suffix, 200]);
      }
  });

  test("another person gets the answer of a conversation that does not exist", async () => {
    const missing = await world.http(
      "GET",
      "/v1/conversations/00000000-0000-4000-8000-00000000dead",
      undefined,
      world.other.key,
    );
    expect(missing.status).toBe(404);
    for (const suffix of [...READS, "/draft/snapshots", "/stream"]) {
      const response = await world.http(
        "GET",
        `/v1/conversations/${conversationId}${suffix}`,
        undefined,
        world.other.key,
      );
      expect([suffix, response.status]).toEqual([suffix, 404]);
      expect((response.body as { code: string; message: string }).code).toBe(
        (missing.body as { code: string }).code,
      );
      expect((response.body as { message: string }).message).toBe(
        (missing.body as { message: string }).message,
      );
    }
    const chatPath = `/v1/conversations/${chatId}`;
    const privateChat = await world.http("GET", chatPath, undefined, world.other.key);
    expect(privateChat.status).toBe(404);
    await world.ctx.db
      .update(conversations)
      .set({ visibility: "team" })
      .where(and(eq(conversations.tenant_id, world.ctx.tenantId), eq(conversations.id, chatId)));
    const shared = await world.http("GET", chatPath, undefined, world.other.key);
    expect(shared.status).toBe(200);
  });

  test("the list shows it to the owner and an admin only and counts accordingly", async () => {
    for (const filter of ["only", "all"]) {
      const own = await listed(world.owner.key, filter);
      expect(own.items.map((item) => item.id)).toContain(conversationId);
      const admin = await listed(world.admin.key, filter);
      expect(admin.items.map((item) => item.id)).toContain(conversationId);
      const foreign = await listed(world.other.key, filter);
      expect(foreign.items.map((item) => item.id)).not.toContain(conversationId);
      expect(foreign.total).toBe(admin.total - 1);
    }
    const chats = await listed(world.other.key, "all");
    expect(chats.items.map((item) => item.id)).toContain(chatId);
  });

  test("the MCP read of a conversation follows the same rule", async () => {
    const db = world.ctx.db;
    const foreign = await readConversationCommit(db, world.other.principal, conversationId);
    expect(JSON.stringify(foreign)).toContain("conversation not found");
    const own = await readConversationCommit(db, world.owner.principal, conversationId);
    expect(JSON.stringify(own)).not.toContain("conversation not found");
  });

  test("another person cannot copy it by forking, and the playbook tool takes no conversation to point at", async () => {
    const [message] = await world.ctx.db
      .insert(conversationMessages)
      .values({
        tenant_id: world.ctx.tenantId,
        conversation_id: conversationId,
        role: "assistant",
        content: { text: "Private result." },
      })
      .returning({ id: conversationMessages.id });
    if (!message) throw new Error("missing message");
    const path = `/v1/conversations/${conversationId}/fork-from-message/${message.id}`;
    const foreign = await world.http("POST", path, undefined, world.other.key);
    expect(foreign.status).toBe(404);
    expect((foreign.body as { code: string }).code).toBe("not_found");
    const [copies] = await world.ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, world.ctx.tenantId),
          sql`${conversationMessages.content}->>'text' = 'Private result.'`,
        ),
      );
    expect(copies?.count).toBe(1);
    const own = await world.http("POST", path, undefined, world.owner.key);
    expect(own.status).toBeLessThan(300);

    const tool = getTool("inspect_playbook");
    if (!tool) throw new Error("inspect_playbook is not registered");
    expect(tool.inputSchema.safeParse({ conversation_id: conversationId }).success).toBe(false);
    expect(tool.inputSchema.safeParse({}).success).toBe(true);
  });

  test("a conversation whose run settings cannot be read is for admins only", async () => {
    await world.ctx.db
      .update(conversations)
      .set({
        draft: sql`jsonb_set(${conversations.draft}, '{session,task_run}', '"broken"'::jsonb)`,
      })
      .where(
        and(eq(conversations.tenant_id, world.ctx.tenantId), eq(conversations.id, conversationId)),
      );
    const path = `/v1/conversations/${conversationId}`;
    expect((await world.http("GET", path, undefined, world.owner.key)).status).toBe(404);
    expect((await world.http("GET", path, undefined, world.other.key)).status).toBe(404);
    expect((await world.http("GET", path, undefined, world.admin.key)).status).toBe(200);
  });
});
