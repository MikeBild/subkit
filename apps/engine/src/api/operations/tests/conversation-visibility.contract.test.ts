import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, conversationMessages, conversations, users } from "../../../db/schema/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../../http/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";

let ctx: HttpTestServer;
let admin: Record<string, string>;
let member: Record<string, string>;
let adminKey: Record<string, string>;
let conversationId: string;

const TITLE = "Quarterly numbers for Anna";

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as Record<string, unknown> & {
      items?: Array<Record<string, unknown>>;
    },
  };
}

async function auditCount(action: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, action),
        eq(auditLog.resource_id, conversationId),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("conversation_visibility_contract");
  const [person] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-visibility@test.local",
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!person) throw new Error("missing member fixture");
  admin = await browserSessionHeaders(ctx, ctx.userId);
  member = await browserSessionHeaders(ctx, person.id);
  adminKey = { authorization: `Bearer ${ctx.apiKey}` };
  const [row] = await ctx.db
    .insert(conversations)
    .values({
      tenant_id: ctx.tenantId,
      status: "active",
      owner_id: person.id,
      surface: "web",
      title: TITLE,
    })
    .returning({ id: conversations.id });
  if (!row) throw new Error("missing conversation fixture");
  conversationId = row.id;
  await ctx.db.insert(conversationMessages).values({
    tenant_id: ctx.tenantId,
    conversation_id: conversationId,
    role: "user",
    content: { text: "salary figures" },
  });
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
});

describe("conversation visibility contract", () => {
  test("a new conversation is private: an admin gets 404 and sees metadata only in the list", async () => {
    const path = `/v1/conversations/${conversationId}`;
    expect((await call("GET", path, admin)).status).toBe(404);
    expect((await call("GET", `${path}/attachments`, admin)).status).toBe(404);
    const list = await call("GET", "/v1/conversations?limit=200", admin);
    const item = list.body.items?.find((entry) => entry.id === conversationId);
    expect(item).toMatchObject({
      visibility: "private",
      content_hidden: true,
      title: null,
      last_message_excerpt: null,
    });
    const searched = await call("GET", "/v1/conversations?q=salary&limit=200", admin);
    expect(searched.body.items?.some((entry) => entry.id === conversationId)).toBe(false);
  });

  test("an admin lists one person's conversations by owner_id, private ones as metadata only", async () => {
    const [row] = await ctx.db
      .select({ owner_id: conversations.owner_id })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, ctx.tenantId), eq(conversations.id, conversationId)));
    const ownerId = row?.owner_id ?? "";
    const theirs = await call("GET", `/v1/conversations?owner_id=${ownerId}&limit=200`, admin);
    expect(theirs.status).toBe(200);
    expect(theirs.body.items?.every((entry) => entry.owner_id === ownerId)).toBe(true);
    expect(theirs.body.items?.find((entry) => entry.id === conversationId)).toMatchObject({
      content_hidden: true,
      title: null,
    });
    const mine = await call("GET", `/v1/conversations?owner_id=${ctx.userId}&limit=200`, admin);
    expect(mine.body.items?.some((entry) => entry.id === conversationId)).toBe(false);
  });

  test("sharing needs the owner's confirmation in a browser session", async () => {
    const path = `/v1/conversations/${conversationId}/share`;
    expect((await call("POST", path, member, {})).status).toBe(400);
    const other = await call("POST", path, admin, { confirm: true });
    expect(other.status).toBe(404);
    expect(await auditCount("conversation.shared")).toBe(0);
  });

  test("an API key of the owner is refused with human_confirmation_required", async () => {
    const [own] = await ctx.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenantId, status: "active", owner_id: ctx.userId })
      .returning({ id: conversations.id });
    const refused = await call("POST", `/v1/conversations/${own?.id}/share`, adminKey, {
      confirm: true,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("human_confirmation_required");
  });

  test("the owner shares: the team reads, only the owner writes, sharing twice is a conflict", async () => {
    const shared = await call("POST", `/v1/conversations/${conversationId}/share`, member, {
      confirm: true,
    });
    expect(shared.status).toBe(200);
    expect(shared.body.visibility).toBe("team");
    expect(await auditCount("conversation.shared")).toBe(1);

    const again = await call("POST", `/v1/conversations/${conversationId}/share`, member, {
      confirm: true,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_shared");
    expect(await auditCount("conversation.shared")).toBe(1);

    expect((await call("GET", `/v1/conversations/${conversationId}`, admin)).status).toBe(200);
    const write = await call("PATCH", `/v1/conversations/${conversationId}`, admin, {
      title: "Taken over",
    });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe("conversation_read_only");
    const unshareByOther = await call(
      "POST",
      `/v1/conversations/${conversationId}/unshare`,
      admin,
      { confirm: true },
    );
    expect(unshareByOther.status).toBe(403);
    expect(unshareByOther.body.code).toBe("not_conversation_owner");
  });

  test("the owner takes it back, then an admin may still delete it without reading it", async () => {
    const unshared = await call("POST", `/v1/conversations/${conversationId}/unshare`, member, {
      confirm: true,
    });
    expect(unshared.status).toBe(200);
    expect(unshared.body.visibility).toBe("private");
    expect(await auditCount("conversation.unshared")).toBe(1);
    expect((await call("GET", `/v1/conversations/${conversationId}`, admin)).status).toBe(404);
    expect((await call("DELETE", `/v1/conversations/${conversationId}`, admin)).status).toBe(200);
    const [deleted] = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "conversation.deleted"),
          eq(auditLog.resource_id, conversationId),
        ),
      );
    expect(deleted?.metadata).toMatchObject({ title: null });
    expect(JSON.stringify(deleted?.metadata)).not.toContain(TITLE);
  });
});
