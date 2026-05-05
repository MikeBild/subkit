// User story: As a member user, I can chat with the assistant and
// iterate on drafts, but I cannot read the audit log and my tenant
// switches require explicit membership. The test user is seeded with
// the `member` built-in role which grants conversation:* but not
// audit:read or workflow:delete.
//
// Acceptance criteria:
//
//   AC1. A member can POST /v1/conversations and receive a 201 — the
//        conversation:write → workflow:write fallback in
//        requireAnyPermission is exercised.
//   AC2. A member POSTing with a memory payload writes the memory
//        onto the conversation row and emits CONVERSATION_MEMORY_INJECTED.
//   AC3. A member is denied GET /v1/audit-log with a 403 and a
//        policy.denied audit row attributed to the member user.
//   AC4. A member PATCHing /v1/conversations/:id with a new model
//        succeeds (conversation:write grant) and the PATCH is audited.
//
// Audit coverage: CONVERSATION_CREATED, CONVERSATION_MEMORY_INJECTED,
// CONVERSATION_UPDATED, policy.denied (audit:read).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, users } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let memberId: string;
let memberApiKey: string;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

async function memberFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${memberApiKey}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
}

async function findAudit(
  action: string,
  opts: { resource_id?: string; actor_id?: string } = {},
): Promise<Array<Record<string, unknown>>> {
  const q = new URLSearchParams({ action, limit: "50" });
  if (opts.actor_id) q.set("actor_id", opts.actor_id);
  const res = await journeyFetch(ctx, `/v1/audit-log?${q.toString()}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<Record<string, unknown>> };
  return opts.resource_id
    ? body.items.filter((row) => row.resource_id === opts.resource_id)
    : body.items;
}

describe("journey: sk-cli member daily driver", () => {
  let conversationId = "";

  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-02-member");
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "member@sk-cli-02.test",
        role: "member",
        role_id: ctx.rbacRoleIds.member,
      })
      .returning();
    if (!u) throw new Error("failed to seed member user");
    memberId = u.id;

    const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
    memberApiKey = `wf_live_${rand}`;
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: memberId,
      prefix: memberApiKey.slice(0, 12),
      token_sha256: sha256Hex(memberApiKey),
      scopes: ["*"],
    });
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  }, 60_000);

  test("AC1: member can POST /v1/conversations", async () => {
    const res = await memberFetch("/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ initial_message: "hello from a member" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { conversation: { id: string; owner_id: string | null } };
    conversationId = body.conversation.id;
    expect(body.conversation.owner_id).toBe(memberId);
    const rows = await findAudit("conversation.created", {
      resource_id: conversationId,
      actor_id: memberId,
    });
    expect(rows.length).toBe(1);
  });

  test("AC2: member POST with memory emits CONVERSATION_MEMORY_INJECTED", async () => {
    const res = await memberFetch(`/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: "turn with memory", memory: "# hints" }),
    });
    expect(res.status).toBe(200);
    const rows = await findAudit("conversation.memory_injected", {
      resource_id: conversationId,
      actor_id: memberId,
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("AC3: member is denied GET /v1/audit-log with policy.denied row", async () => {
    const res = await memberFetch("/v1/audit-log");
    expect(res.status).toBe(403);
    const denials = await findAudit("policy.denied", { actor_id: memberId });
    const auditDenial = denials.find(
      (r) =>
        (r.metadata as { permission?: string }).permission === "audit:read" ||
        (r.metadata as { permission?: string }).permission?.startsWith("audit"),
    );
    expect(auditDenial).toBeDefined();
  });

  test("AC4: member PATCH /v1/conversations/:id is accepted and audited", async () => {
    const res = await memberFetch(`/v1/conversations/${conversationId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "member authored", model: "anthropic:claude-sonnet-4-6" }),
    });
    expect(res.status).toBe(200);
    const rows = await findAudit("conversation.updated", {
      resource_id: conversationId,
      actor_id: memberId,
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
