import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { users } from "../../../../db/schema/index.ts";
import { issueApiKey } from "../../../../identity/service.ts";
import { builtinRoleId } from "../../../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../tests/setup.ts";
import { _resetInviteRedeemRateLimitForTests } from "../invites.ts";

let ctx: HttpTestServer;
let memberKey = "";

beforeAll(async () => {
  ctx = await createHttpTestServer("invites");

  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-invites@test.local",
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!member) throw new Error("seed member failed");
  const issued = await issueApiKey(
    { tenant_id: ctx.tenantId, owner_kind: "user", owner_id: member.id, actor_id: null },
    ctx.db,
  );
  memberKey = issued.plaintext;
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  _resetInviteRedeemRateLimitForTests();
});

function adminHeaders() {
  return { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
}

describe("admin happy path", () => {
  test("create user → create invite → redeem (no auth) → key authenticates → deactivate revokes", async () => {
    const createRes = await fetch(`${ctx.baseUrl}/v1/identity/users`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ email: "invited-user@test.local", role: "member" }),
    });
    expect(createRes.status).toBe(201);
    const user = (await createRes.json()) as { id: string; status: string };
    expect(user.status).toBe("active");

    const inviteRes = await fetch(`${ctx.baseUrl}/v1/identity/users/${user.id}/invites`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ scopes: ["*"] }),
    });
    expect(inviteRes.status).toBe(201);
    const invite = (await inviteRes.json()) as { id: string; plaintext_token: string };
    expect(invite.plaintext_token).toMatch(/^wf_invite_/);

    const listRes = await fetch(`${ctx.baseUrl}/v1/identity/invites`, { headers: adminHeaders() });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: Array<Record<string, unknown>> };
    const row = list.items.find((i) => i.id === invite.id);
    expect(row).toBeDefined();
    expect(row?.plaintext_token).toBeUndefined();

    const redeemRes = await fetch(`${ctx.baseUrl}/v1/identity/invites/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: invite.plaintext_token }),
    });
    expect(redeemRes.status).toBe(200);
    const redeemed = (await redeemRes.json()) as { api_key: string; user_id: string };
    expect(redeemed.api_key).toMatch(/^wf_live_/);
    expect(redeemed.user_id).toBe(user.id);

    const [refreshed] = await ctx.db.select().from(users).where(eq(users.id, user.id));
    expect(refreshed?.status).toBe("active");

    const whoamiRes = await fetch(`${ctx.baseUrl}/v1/identity/whoami`, {
      headers: { authorization: `Bearer ${redeemed.api_key}` },
    });
    expect(whoamiRes.status).toBe(200);
    const whoami = (await whoamiRes.json()) as { id: string };
    expect(whoami.id).toBe(user.id);

    const replay = await fetch(`${ctx.baseUrl}/v1/identity/invites/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: invite.plaintext_token }),
    });
    expect(replay.status).toBe(400);
    const replayBody = (await replay.json()) as { code: string };
    expect(replayBody.code).toBe("invite_already_redeemed");

    const deactivateRes = await fetch(`${ctx.baseUrl}/v1/identity/users/${user.id}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    expect(deactivateRes.status).toBe(204);

    const afterRes = await fetch(`${ctx.baseUrl}/v1/identity/whoami`, {
      headers: { authorization: `Bearer ${redeemed.api_key}` },
    });
    expect(afterRes.status).toBe(401);
  });
});

describe("member is refused write operations", () => {
  const memberHeaders = () => ({
    authorization: `Bearer ${memberKey}`,
    "content-type": "application/json",
  });

  test("member cannot create a user", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/users`, {
      method: "POST",
      headers: memberHeaders(),
      body: JSON.stringify({ email: "should-not-exist@test.local" }),
    });
    expect(res.status).toBe(403);
  });

  test("member cannot issue an invite", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/users/${ctx.userId}/invites`, {
      method: "POST",
      headers: memberHeaders(),
      body: JSON.stringify({ scopes: ["*"] }),
    });
    expect(res.status).toBe(403);
  });

  test("member cannot list invites", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/invites`, { headers: memberHeaders() });
    expect(res.status).toBe(403);
  });
});

describe("redeem rejects bad tokens", () => {
  test("malformed token → 400 invite_invalid", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/invites/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wf_invite_deadbeefdeadbeefdeadbeefdeadbeef" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invite_invalid");
  });
});
