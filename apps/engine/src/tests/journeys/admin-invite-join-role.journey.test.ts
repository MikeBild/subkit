import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const INVITEE = "lena.kraus@test.local";

interface PairApprover {
  kind: string;
  pair?: string;
  invitation?: string;
  can_approve?: boolean | null;
  user_id?: string | null;
}

let ctx: JourneyCtx;
let inviteeId = "";
let inviteToken = "";
let inviteeKey = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("admin-invite-join-role");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

function asInvitee(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${inviteeKey}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
}

function redeem(token: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}/v1/identity/invites/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

async function choosePair(): Promise<PairApprover> {
  const res = await journeyFetch(ctx, "/v1/identity/me/setup", {
    method: "PUT",
    body: JSON.stringify({ approver: { kind: "pair", email: INVITEE } }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { approver: PairApprover }).approver;
}

function createSomeone(path: (p: string, i: RequestInit) => Promise<Response>, email: string) {
  return path("/v1/identity/users", { method: "POST", body: JSON.stringify({ email }) });
}

describe("an admin invites a person, the person joins and sees what the role allows", () => {
  test("the admin invites a member and gets a single-use invitation", async () => {
    const res = await journeyFetch(ctx, "/v1/identity/users", {
      method: "POST",
      body: JSON.stringify({
        email: INVITEE,
        display_name: "Lena Kraus",
        role: "member",
        invite: {},
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      status: string;
      role: string;
      invite: { plaintext_token: string; redeemed_at: string | null };
    };
    expect(created).toMatchObject({ status: "invited", role: "member" });
    expect(created.invite.redeemed_at).toBeNull();
    inviteeId = created.id;
    inviteToken = created.invite.plaintext_token;
    expect(inviteToken.length).toBeGreaterThan(0);
  });

  test("two-person approval waits while the partner has not joined", async () => {
    expect(await choosePair()).toMatchObject({
      kind: "pair",
      invitation: "pending",
      pair: "needs_second_approver",
    });
  });

  test("the invitation turns into the person's own key exactly once", async () => {
    const redeemed = await redeem(inviteToken);
    expect(redeemed.status).toBe(200);
    const joined = (await redeemed.json()) as {
      user_id: string;
      tenant_id: string;
      api_key: string;
    };
    expect(joined).toMatchObject({ user_id: inviteeId, tenant_id: ctx.tenantId });
    inviteeKey = joined.api_key;

    expect((await redeem(inviteToken)).status).toBe(400);

    const person = await journeyFetch(ctx, `/v1/identity/users/${inviteeId}`);
    expect(((await person.json()) as { status: string }).status).toBe("active");
  });

  test("as a member the person reads workflows but neither audit nor people admin", async () => {
    const me = await asInvitee("/v1/identity/whoami");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      id: inviteeId,
      kind: "user",
      tenant_id: ctx.tenantId,
      role_name: "member",
    });

    expect((await asInvitee("/v1/workflows")).status).toBe(200);
    expect((await asInvitee("/v1/audit-log")).status).toBe(403);
    expect((await createSomeone(asInvitee, "someone-else@test.local")).status).toBe(403);
  });

  test("once the partner joined, two-person approval becomes active", async () => {
    expect(await choosePair()).toMatchObject({
      kind: "pair",
      invitation: "member",
      user_id: inviteeId,
      can_approve: true,
      pair: "active",
    });
  });

  test("after the role change the person reads the audit log and adds people", async () => {
    const promoted = await journeyFetch(ctx, `/v1/identity/users/${inviteeId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    });
    expect(promoted.status).toBe(200);
    expect(((await promoted.json()) as { role: string }).role).toBe("admin");

    expect((await asInvitee("/v1/identity/whoami").then((r) => r.json())) as object).toMatchObject({
      role_name: "admin",
    });
    expect((await asInvitee("/v1/audit-log")).status).toBe(200);
    expect((await createSomeone(asInvitee, "someone-else@test.local")).status).toBe(201);
  });

  test("the audit log tells the story of the invitation, the join and the role change", async () => {
    const res = await journeyFetch(ctx, "/v1/audit-log?limit=500");
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as {
      items: Array<{ action: string; resource_id: string | null }>;
    };
    const about = (action: string) =>
      items.some((row) => row.action === action && row.resource_id === inviteeId);
    expect(about("user.created")).toBe(true);
    expect(about("user.role_changed")).toBe(true);
    expect(items.map((row) => row.action)).toContain("user_invite.redeemed");
    expect(items.map((row) => row.action)).toContain("workspace.approval_policy_changed");
  });
});
