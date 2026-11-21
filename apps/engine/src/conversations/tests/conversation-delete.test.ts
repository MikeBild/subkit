import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, conversations, fileLinks, files } from "../../db/schema/index.ts";
import { insertMcpTask } from "../../mcp/tasks/store.ts";
import { registerConversationAbort, unregisterConversationAbort } from "../abort.ts";
import { createConversation, deleteConversation } from "../service/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("conv_delete");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function newConversation(title: string): Promise<string> {
  const created = await createConversation(
    { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, initial_message: title },
    ctx.testDb.db,
  );
  const id = created.conversation.id;
  await ctx.testDb.db.update(conversations).set({ title }).where(eq(conversations.id, id));
  return id;
}

function del(conversation_id: string, actor_id: string, actor_is_admin: boolean) {
  return deleteConversation(
    {
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id,
      actor_type: "user",
      actor_is_admin,
      request_source: "api",
    },
    ctx.testDb.db,
  );
}

describe("deleteConversation", () => {
  test("the owner deletes it with its file links; the file stays and the audit row names it", async () => {
    const id = await newConversation("Quarterly numbers");
    const [file] = await ctx.testDb.db
      .insert(files)
      .values({
        tenant_id: ctx.tenant_id,
        filename: "q3.csv",
        storage_uri: "s3://bucket/q3.csv",
        status: "ready",
      })
      .returning();
    await ctx.testDb.db.insert(fileLinks).values({
      tenant_id: ctx.tenant_id,
      file_id: file!.id,
      resource_type: "conversation",
      resource_id: id,
      slug: "q3",
      role: "attachment",
    });

    const result = await del(id, ctx.user_id, false);
    expect(result).toEqual({ kind: "deleted", id, title: "Quarterly numbers" });

    const left = await ctx.testDb.db.select().from(conversations).where(eq(conversations.id, id));
    expect(left).toHaveLength(0);
    const links = await ctx.testDb.db
      .select()
      .from(fileLinks)
      .where(and(eq(fileLinks.resource_type, "conversation"), eq(fileLinks.resource_id, id)));
    expect(links).toHaveLength(0);
    const kept = await ctx.testDb.db.select().from(files).where(eq(files.id, file!.id));
    expect(kept).toHaveLength(1);

    const [audit] = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "conversation.deleted"), eq(auditLog.resource_id, id)));
    expect(audit).toBeDefined();
    expect(audit!.metadata).toMatchObject({
      conversation_id: id,
      title: "Quarterly numbers",
      file_links_removed: 1,
      request_source: "api",
    });
  });

  test("someone else may not delete it; an administrator may", async () => {
    const id = await newConversation("Somebody's chat");
    const stranger = "7f3c2a10-5b4e-4c6d-9e8f-0a1b2c3d4e5f";
    expect(await del(id, stranger, false)).toEqual({ kind: "forbidden" });
    expect((await del(id, stranger, true)).kind).toBe("deleted");
  });

  test("an unknown conversation is not found", async () => {
    expect(await del("0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a", ctx.user_id, true)).toEqual({
      kind: "not_found",
    });
  });

  test("a turn running in this process blocks the delete", async () => {
    const id = await newConversation("Busy");
    const ctrl = registerConversationAbort(ctx.tenant_id, id);
    try {
      expect(await del(id, ctx.user_id, false)).toEqual({ kind: "turn_running" });
    } finally {
      unregisterConversationAbort(ctx.tenant_id, id, ctrl);
    }
    expect((await del(id, ctx.user_id, false)).kind).toBe("deleted");
  });

  test("an unfinished background turn blocks the delete", async () => {
    const id = await newConversation("Queued");
    await insertMcpTask(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: id,
        kind: "append",
        actor: { kind: "user", id: ctx.user_id },
        request_source: "mcp",
        user_message_id: null,
      },
      ctx.testDb.db,
    );
    expect(await del(id, ctx.user_id, false)).toEqual({ kind: "turn_running" });
  });
});
