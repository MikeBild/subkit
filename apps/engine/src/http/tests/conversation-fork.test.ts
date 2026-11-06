import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  apiKeys,
  auditLog,
  conversationMessages,
  conversations,
  roles,
  systemAccounts,
} from "../../db/schema/index.ts";
import { adminHeaders, seedTenant } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let conversation_id: string;
let anchor_message_id: string;
let memberKey = "";
let otherTenantConvId: string;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function newKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

beforeAll(async () => {
  srv = await createHttpTestServer("conv-fork");

  const [c] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active", title: "fork-source" })
    .returning();
  conversation_id = c!.id;

  const [m0] = await srv.db
    .insert(conversationMessages)
    .values({
      tenant_id: srv.tenantId,
      conversation_id,
      role: "user",
      content: { text: "first" },
    })
    .returning();
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
  const [m1] = await srv.db
    .insert(conversationMessages)
    .values({
      tenant_id: srv.tenantId,
      conversation_id,
      role: "assistant",
      content: { text: "second" },
    })
    .returning();
  anchor_message_id = m1!.id;
  void m0;

  const [scraperRole] = await srv.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, "metrics_scraper")));
  if (!scraperRole) throw new Error("metrics_scraper role not seeded");
  const [scraperAcct] = await srv.db
    .insert(systemAccounts)
    .values({
      tenant_id: srv.tenantId,
      name: "fork-denied-scraper",
      description: "scoped to metrics:read only",
      role_id: scraperRole.id,
    })
    .returning();
  const key = newKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    system_account_id: scraperAcct!.id,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes: ["metrics:read"],
  });
  memberKey = key.plaintext;

  const otherTenant = await seedTenant(srv.db, { slug: "t-fork-other", display_name: "other" });
  const [otherConv] = await srv.db
    .insert(conversations)
    .values({ tenant_id: otherTenant.id, status: "active" })
    .returning();
  otherTenantConvId = otherConv!.id;
});

afterAll(async () => {
  await srv.cleanup();
});

describe("POST /v1/conversations/:id/fork-from-message/:message_id (RBAC + tenant)", () => {
  test("admin → 200 + audit row carries CONVERSATION_FORKED metadata", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/fork-from-message/${anchor_message_id}`,
      { method: "POST", headers: adminHeaders(srv.apiKey) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { id: string; tenant_id: string };
      source_conversation_id: string;
      anchor_message_id: string;
      copied_message_count: number;
    };
    expect(body.source_conversation_id).toBe(conversation_id);
    expect(body.anchor_message_id).toBe(anchor_message_id);
    expect(body.copied_message_count).toBe(2);
    expect(body.conversation.tenant_id).toBe(srv.tenantId);
    expect(body.conversation.id).not.toBe(conversation_id);

    const audits = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.resource_id, body.conversation.id)),
      );
    expect(audits.length).toBe(1);
    expect(audits[0]!.action).toBe("conversation.forked");
    const meta = audits[0]!.metadata as Record<string, unknown>;
    expect(meta.forked_from).toBe(conversation_id);
    expect(meta.copied_message_count).toBe(2);
  });

  test("scoped api-key without conversation:write/workflow:write → 403", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/fork-from-message/${anchor_message_id}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${memberKey}`,
          "content-type": "application/json",
        },
      },
    );
    expect(res.status).toBe(403);
  });

  test("cross-tenant source conversation → 404", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${otherTenantConvId}/fork-from-message/${anchor_message_id}`,
      { method: "POST", headers: adminHeaders(srv.apiKey) },
    );
    expect(res.status).toBe(404);
  });

  test("non-existent anchor message → 404", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/fork-from-message/00000000-0000-0000-0000-000000000000`,
      { method: "POST", headers: adminHeaders(srv.apiKey) },
    );
    expect(res.status).toBe(404);
  });

  test("admin → fork carries memory and loaded_skills from the source row", async () => {
    const [src] = await srv.db
      .insert(conversations)
      .values({
        tenant_id: srv.tenantId,
        status: "active",
        title: "fork-carryover-source",
        memory: "carry-this-memory-string",
        loaded_skills: [
          { slug: "skill.alpha", last_turn: 0 },
          { slug: "skill.beta", last_turn: 0 },
        ],
      })
      .returning();

    const [seedAnchor] = await srv.db
      .insert(conversationMessages)
      .values({
        tenant_id: srv.tenantId,
        conversation_id: src!.id,
        role: "assistant",
        content: { text: "anchor" },
      })
      .returning();

    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${src!.id}/fork-from-message/${seedAnchor!.id}`,
      { method: "POST", headers: adminHeaders(srv.apiKey) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { id: string } };

    const [forked] = await srv.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, body.conversation.id));
    expect(forked).toBeDefined();
    expect(forked!.memory).toBe("carry-this-memory-string");
    expect(forked!.loaded_skills).toEqual([
      { slug: "skill.alpha", last_turn: 0 },
      { slug: "skill.beta", last_turn: 0 },
    ]);
  });

  test("admin → fork audit row records tool_calls_omitted + elicitations_omitted", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/fork-from-message/${anchor_message_id}`,
      { method: "POST", headers: adminHeaders(srv.apiKey) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { id: string } };
    const audits = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.resource_id, body.conversation.id)),
      );
    expect(audits.length).toBe(1);
    const meta = audits[0]!.metadata as Record<string, unknown>;
    expect(meta.tool_calls_omitted).toBe(true);
    expect(meta.elicitations_omitted).toBe(true);
    expect(meta.request_source).toBe("api");
  });
});
