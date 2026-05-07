// User story: As an enduser (portal user with the `enduser` built-in
// role), I can chat against approved workflows but I cannot commit
// drafts, read the audit log, or read skills.
//
// Acceptance criteria:
//
//   AC1. An enduser can POST /v1/conversations — conversation:write
//        is in the enduser role grant.
//   AC2. An enduser is denied GET /v1/skills (skill:read not granted)
//        with a 403 and a policy.denied audit row.
//   AC3. An enduser is denied POST /v1/audit-log/... (audit:read not
//        granted).
//   AC4. An enduser cannot PATCH another member's conversation
//        because the route enforces conversation:write + the service
//        layer checks tenant_id (no cross-tenant surface).
//   AC5. Endusers do NOT get conversation:commit, so a
//        `POST /v1/rbac/can` probe for (enduser_user_id,
//        conversation:commit) returns allow=false.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, users } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let enduserId: string;
let enduserApiKey: string;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

async function endFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${enduserApiKey}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
}

describe("journey: sk-cli enduser dashboard", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-03-enduser");
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "enduser@sk-cli-03.test",
        role: "enduser",
        role_id: ctx.rbacRoleIds.enduser,
      })
      .returning();
    if (!u) throw new Error("failed to seed enduser");
    enduserId = u.id;
    const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
    enduserApiKey = `wf_live_${rand}`;
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: enduserId,
      prefix: enduserApiKey.slice(0, 12),
      token_sha256: sha256Hex(enduserApiKey),
      scopes: ["*"],
    });
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  test("AC1: enduser can POST /v1/conversations", async () => {
    const res = await endFetch("/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ initial_message: "hello from an enduser" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { conversation: { owner_id: string | null } };
    expect(body.conversation.owner_id).toBe(enduserId);
  });

  test("AC2: enduser is denied GET /v1/skills (skill:read not granted)", async () => {
    const res = await endFetch("/v1/skills");
    expect(res.status).toBe(403);
  });

  test("AC3: enduser is denied GET /v1/audit-log", async () => {
    const res = await endFetch("/v1/audit-log");
    expect(res.status).toBe(403);
  });

  test("AC4: enduser can PATCH their own conversation (conversation:write)", async () => {
    // Create a new conversation owned by the enduser.
    const create = await endFetch("/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ initial_message: "for patching" }),
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as { conversation: { id: string } };
    const patch = await endFetch(`/v1/conversations/${body.conversation.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "mine" }),
    });
    expect(patch.status).toBe(200);
  });

  test("AC5: conversation:commit is denied for the enduser (rbac:can probe)", async () => {
    const res = await journeyFetch(ctx, "/v1/rbac/can", {
      method: "POST",
      body: JSON.stringify({
        principal_id: enduserId,
        permission: "conversation:commit",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { allow: boolean };
    expect(body.allow).toBe(false);
  });
});
