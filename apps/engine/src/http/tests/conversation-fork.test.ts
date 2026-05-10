// C2 of PR #161 review — HTTP-layer coverage for the new
// `POST /v1/conversations/:id/fork-from-message/:message_id` route:
//
//   - admin api key with conversation:write → 200 + audit row written
//     under CONVERSATION_FORKED with metadata
//   - member api key without conversation:write/workflow:write → 403
//     + audit denied
//   - cross-tenant source conversation → 404
//   - anchor message that doesn't exist → 404

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
  tenants,
} from "../../db/schema/index.ts";
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

  // Seed a conversation with two messages so we have a valid anchor.
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
  // Yield two macrotask ticks so the second message lands with a
  // strictly-later created_at than the first. Postgres' defaultNow()
  // resolves at insert-time per row; we don't care about the
  // wall-clock magnitude, only that ordering is stable. Avoids a
  // wall-clock setTimeout (flagged by check:determinism).
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
  // Anchor at message 1 (the assistant turn). Fork should copy 2 rows.
  anchor_message_id = m1!.id;
  void m0;

  // A principal whose role does NOT grant conversation:write or
  // workflow:write — used to verify the 403 RBAC denial. Built-in
  // `member` / `enduser` / `portal_token_user` all carry
  // conversation:write, so we use the `metrics_scraper` role
  // (METRICS_SCRAPER_PERMISSIONS = ["metrics:read"] in rbac/seed.ts).
  // System accounts can be assigned any role directly via role_id.
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

  // A second tenant + conversation for the cross-tenant test.
  const [otherTenant] = await srv.db
    .insert(tenants)
    .values({ slug: "t-fork-other", display_name: "other" })
    .returning();
  const [otherConv] = await srv.db
    .insert(conversations)
    .values({ tenant_id: otherTenant!.id, status: "active" })
    .returning();
  otherTenantConvId = otherConv!.id;
});

afterAll(async () => {
  await srv.cleanup();
});

function adminHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${srv.apiKey}`,
    "content-type": "application/json",
  };
}

describe("POST /v1/conversations/:id/fork-from-message/:message_id (RBAC + tenant)", () => {
  test("admin → 200 + audit row carries CONVERSATION_FORKED metadata", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/fork-from-message/${anchor_message_id}`,
      { method: "POST", headers: adminHeaders() },
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
    // Admin from the primary tenant tries to fork a conversation that
    // belongs to a different tenant. The route handler reads
    // principal.tenant_id, so the lookup is naturally tenant-scoped
    // and returns NotFound regardless of caller perms.
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${otherTenantConvId}/fork-from-message/${anchor_message_id}`,
      { method: "POST", headers: adminHeaders() },
    );
    expect(res.status).toBe(404);
  });

  test("non-existent anchor message → 404", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/fork-from-message/00000000-0000-0000-0000-000000000000`,
      { method: "POST", headers: adminHeaders() },
    );
    expect(res.status).toBe(404);
  });

  // S-4 of PR #161 review (round 3): the service-layer test at
  // `apps/engine/src/conversations/service/fork.test.ts` covers the
  // memory + loaded_skills carry-over, but the HTTP route is the
  // operator-facing surface. Pin the same contract here so a route-
  // layer regression that drops either field can't slip past.
  test("admin → fork carries memory and loaded_skills from the source row", async () => {
    // Seed a fresh source conversation tagged with both the memory
    // text and the loaded_skills array. Use a dedicated row so the
    // earlier "fork-source" conversation's empty defaults aren't
    // observed.
    const [src] = await srv.db
      .insert(conversations)
      .values({
        tenant_id: srv.tenantId,
        status: "active",
        title: "fork-carryover-source",
        memory: "carry-this-memory-string",
        loaded_skills: ["skill.alpha", "skill.beta"],
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
      { method: "POST", headers: adminHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { id: string } };

    const [forked] = await srv.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, body.conversation.id));
    expect(forked).toBeDefined();
    expect(forked!.memory).toBe("carry-this-memory-string");
    expect(forked!.loaded_skills).toEqual(["skill.alpha", "skill.beta"]);
  });

  test("admin → fork audit row records tool_calls_omitted + elicitations_omitted", async () => {
    // S-1 of PR #161 review (round 3): the audit row carries the
    // documented side-effect omissions so log-only incident readers
    // can reconstruct what the fork did NOT bring across.
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/fork-from-message/${anchor_message_id}`,
      { method: "POST", headers: adminHeaders() },
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
  });
});
