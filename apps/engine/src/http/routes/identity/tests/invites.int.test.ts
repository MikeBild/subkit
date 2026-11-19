import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { userIdentities, userInvites, users } from "../../../../db/schema/index.ts";
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
    {
      issuer: { kind: "system" },
      tenant_id: ctx.tenantId,
      owner_kind: "user",
      owner_id: member.id,
      actor_id: null,
    },
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

describe("a person created with an invitation", () => {
  async function invite(email: string, body: Record<string, unknown> = {}) {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/users`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ email, role: "member", invite: {}, ...body }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      id: string;
      status: string;
      invite: { id: string; plaintext_token: string; user_id: string };
    };
  }

  async function preview(token: string) {
    return fetch(`${ctx.baseUrl}/v1/identity/invites/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  }

  test("is invited until the link is redeemed, and the token is shown once", async () => {
    const created = await invite("create-with-invite@test.local");
    expect(created.status).toBe("invited");
    expect(created.invite.user_id).toBe(created.id);
    expect(created.invite.plaintext_token).toMatch(/^wf_invite_/);
    const detail = await fetch(`${ctx.baseUrl}/v1/identity/users/${created.id}`, {
      headers: adminHeaders(),
    });
    expect(await detail.json()).toMatchObject({ status: "invited" });
    expect(
      JSON.stringify(
        await (
          await fetch(`${ctx.baseUrl}/v1/identity/invites`, { headers: adminHeaders() })
        ).json(),
      ),
    ).not.toContain(created.invite.plaintext_token);

    const redeemed = await fetch(`${ctx.baseUrl}/v1/identity/invites/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: created.invite.plaintext_token }),
    });
    expect(redeemed.status).toBe(200);
    const [row] = await ctx.db.select().from(users).where(eq(users.id, created.id));
    expect(row?.status).toBe("active");
  });

  test("a person created without an invitation stays active and carries no invitation", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/users`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ email: "plain-create@test.local" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; invite?: unknown };
    expect(body.status).toBe("active");
    expect(body.invite).toBeUndefined();
  });

  test("a duplicate address creates neither a person nor an invitation", async () => {
    await invite("duplicate-invite@test.local");
    const before = await ctx.db.select().from(userInvites);
    const again = await fetch(`${ctx.baseUrl}/v1/identity/users`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ email: "duplicate-invite@test.local", invite: {} }),
    });
    expect(again.status).toBe(409);
    expect(await ctx.db.select().from(userInvites)).toHaveLength(before.length);
  });

  test("a removed person who had left a sign-in trace can be invited again", async () => {
    const email = "reinvite-after-removal@test.local";
    const first = await invite(email);
    await ctx.db.insert(userIdentities).values({
      tenant_id: ctx.tenantId,
      user_id: first.id,
      provider_id: "workspace-sso",
      subject: "reinvite-subject",
      email,
    });
    const removed = await fetch(`${ctx.baseUrl}/v1/identity/users/${first.id}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    expect(removed.status).toBe(204);
    const [tombstone] = await ctx.db.select().from(users).where(eq(users.id, first.id));
    expect(tombstone?.deleted_at).not.toBeNull();

    const again = await invite(email, { display_name: "Back Again" });
    expect(again.status).toBe("invited");
    expect(again.invite.plaintext_token).not.toBe(first.invite.plaintext_token);
    expect((await preview(again.invite.plaintext_token)).status).toBe(200);
    expect((await preview(first.invite.plaintext_token)).status).toBe(400);
    const listed = (await (
      await fetch(`${ctx.baseUrl}/v1/identity/users?limit=200`, { headers: adminHeaders() })
    ).json()) as { items: Array<{ email: string; status: string; display_name: string | null }> };
    expect(listed.items.filter((person) => person.email === email)).toMatchObject([
      { status: "invited", display_name: "Back Again" },
    ]);

    const duplicate = await fetch(`${ctx.baseUrl}/v1/identity/users`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ email, invite: {} }),
    });
    expect(duplicate.status).toBe(409);
  });

  test("the preview shows the workspace and a masked address without redeeming", async () => {
    const created = await invite("masked-person@test.local");
    const res = await preview(created.invite.plaintext_token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.email_hint).toBe("m•••@test.local");
    expect(typeof body.workspace_name).toBe("string");
    expect(body.invited_by_name).toBeNull();
    expect(body.providers).toEqual([]);
    expect(new Date(String(body.expires_at)).getTime()).toBeGreaterThan(Date.now()); // allow-wall-clock
    expect(JSON.stringify(body)).not.toContain("masked-person");
    const [row] = await ctx.db
      .select()
      .from(userInvites)
      .where(eq(userInvites.id, created.invite.id));
    expect(row?.redeemed_at).toBeNull();
  });

  test("the preview names why a link no longer works", async () => {
    expect(
      await (await preview("wf_invite_deadbeefdeadbeefdeadbeefdeadbeef")).json(),
    ).toMatchObject({
      code: "invite_invalid",
    });
    const expired = await invite("expired-invite@test.local");
    await ctx.db
      .update(userInvites)
      .set({ expires_at: new Date(0) })
      .where(eq(userInvites.id, expired.invite.id));
    const expiredRes = await preview(expired.invite.plaintext_token);
    expect(expiredRes.status).toBe(400);
    expect(await expiredRes.json()).toMatchObject({ code: "invite_expired" });

    const revoked = await invite("revoked-invite@test.local");
    expect(
      (
        await fetch(`${ctx.baseUrl}/v1/identity/invites/${revoked.invite.id}`, {
          method: "DELETE",
          headers: adminHeaders(),
        })
      ).status,
    ).toBe(204);
    expect(await (await preview(revoked.invite.plaintext_token)).json()).toMatchObject({
      code: "invite_revoked",
    });

    const used = await invite("used-invite@test.local");
    await fetch(`${ctx.baseUrl}/v1/identity/invites/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: used.invite.plaintext_token }),
    });
    expect(await (await preview(used.invite.plaintext_token)).json()).toMatchObject({
      code: "invite_already_redeemed",
    });
  });

  test("issuing a new link for an invited person withdraws the previous one", async () => {
    const created = await invite("reissue-invite@test.local");
    const reissued = await fetch(`${ctx.baseUrl}/v1/identity/users/${created.id}/invites`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(reissued.status).toBe(201);
    const next = (await reissued.json()) as { id: string; plaintext_token: string };
    expect(await (await preview(created.invite.plaintext_token)).json()).toMatchObject({
      code: "invite_revoked",
    });
    expect((await preview(next.plaintext_token)).status).toBe(200);
    const pending = await fetch(`${ctx.baseUrl}/v1/identity/invites?status=pending`, {
      headers: adminHeaders(),
    });
    const items = ((await pending.json()) as { items: Array<{ id: string; user_id: string }> })
      .items;
    expect(items.filter((item) => item.user_id === created.id).map((item) => item.id)).toEqual([
      next.id,
    ]);
  });

  test("the preview is rate limited per client address", async () => {
    let last = 200;
    for (let attempt = 0; attempt < 31; attempt += 1) {
      last = (await preview("wf_invite_deadbeefdeadbeefdeadbeefdeadbeef")).status;
    }
    expect(last).toBe(429);
  });
});
