import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { noteApprovedAction } from "../../conversations/approval-rules/store.ts";
import { describeBoundAction } from "../../conversations/instruction-cover/bound-action.ts";
import { toolApprovalRules, users } from "../../db/schema/index.ts";
import { issueApiKey } from "../../identity/service.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/index.ts";
import { ctx, login, setupBrowserMemberships } from "../tests/memberships-fixtures.ts";

setupBrowserMemberships();

type Session = Awaited<ReturnType<typeof login>>;

function headers(session: Session) {
  return {
    cookie: session.cookie,
    "x-subkit-tenant": session.payload.tenant_id,
    "x-subkit-csrf": session.csrf,
    "content-type": "application/json",
  };
}

function send(to: string) {
  return describeBoundAction(
    "call_connector",
    { connector_id: "mail", method: "POST", path: "/v1/messages/send", body: { to } },
    [to],
  );
}

async function offerFor(tenant_id: string, user_id: string, to: string): Promise<string> {
  await noteApprovedAction(ctx.db, { tenant_id, user_id }, send(to));
  const offer = await noteApprovedAction(ctx.db, { tenant_id, user_id }, send(to));
  if (!offer?.offered) throw new Error("offer missing");
  return offer.rule_id;
}

async function call(method: string, path: string, auth: Record<string, string>) {
  const response = await fetch(`${ctx.baseUrl}${path}`, { method, headers: auth });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("approval rules of the signed-in person", () => {
  test("an offer is listed, stored on an explicit yes, and revoked again", async () => {
    const owner = await login("rules-owner");
    const { tenant_id, user_id } = owner.payload;
    const id = await offerFor(tenant_id, user_id, "kunde@example.com");
    const offered = await call("GET", "/v1/approval-rules?state=offered", headers(owner));
    expect(offered.status).toBe(200);
    expect(offered.body.items).toMatchObject([
      {
        id,
        state: "offered",
        tool: "call_connector",
        verb: "send",
        target: "POST /v1/messages/send",
        account: "mail",
        recipients: ["kunde@example.com"],
        approvals_count: 2,
        use_count: 0,
      },
    ]);
    const accepted = await call("POST", `/v1/approval-rules/${id}/accept`, headers(owner));
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ id, state: "active" });
    expect((await call("POST", `/v1/approval-rules/${id}/accept`, headers(owner))).status).toBe(
      409,
    );
    const expires = Date.parse(String(accepted.body.expires_at));
    expect(Math.round((expires - getTestNow()) / 86_400_000)).toBe(90);
    expect(accepted.body).toMatchObject({
      connector: "mail",
      operation: "POST /v1/messages/send",
      recipients: ["kunde@example.com"],
      content_class: "no_content",
      expired: false,
      daily_limit: 20,
      uses_today: 0,
      use_count: 0,
      last_used_at: null,
    });
    await ctx.db
      .update(toolApprovalRules)
      .set({ expires_at: new Date(getTestNow() - 1000) })
      .where(eq(toolApprovalRules.id, id));
    const lapsed = await call("GET", "/v1/approval-rules", headers(owner));
    expect(lapsed.body.items).toMatchObject([{ id, state: "active", expired: true }]);
    const renewed = await call("POST", `/v1/approval-rules/${id}/renew`, headers(owner));
    expect(renewed.status).toBe(200);
    expect(renewed.body).toMatchObject({ id, state: "active", expired: false });
    expect(Date.parse(String(renewed.body.expires_at))).toBeGreaterThan(
      getTestNow() + 89 * 86_400_000,
    );
    const listed = await call("GET", "/v1/approval-rules", headers(owner));
    expect((listed.body.items as Array<{ id: string }>).map((rule) => rule.id)).toEqual([id]);
    const revoked = await call("DELETE", `/v1/approval-rules/${id}`, headers(owner));
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ id, state: "revoked" });
    expect((await call("GET", "/v1/approval-rules", headers(owner))).body.items).toEqual([]);
    const history = await call("GET", "/v1/approval-rules?state=revoked", headers(owner));
    expect((history.body.items as unknown[]).length).toBe(1);
  });

  test("an offer can be declined and another person's rule stays invisible", async () => {
    const owner = await login("rules-decliner");
    const { tenant_id, user_id } = owner.payload;
    const id = await offerFor(tenant_id, user_id, "lieferant@example.com");
    const stranger = await login("rules-stranger");
    expect((await call("POST", `/v1/approval-rules/${id}/accept`, headers(stranger))).status).toBe(
      404,
    );
    expect((await call("GET", "/v1/approval-rules", headers(stranger))).body.items).toEqual([]);
    const dismissed = await call("POST", `/v1/approval-rules/${id}/dismiss`, headers(owner));
    expect(dismissed.body).toMatchObject({ id, state: "dismissed" });
    expect((await call("DELETE", `/v1/approval-rules/${id}`, headers(owner))).status).toBe(409);
  });

  test("a rule is only stored from a signed-in browser session, never with an API key", async () => {
    const owner = await login("rules-key-owner");
    const tenant_id = owner.payload.tenant_id;
    const [member] = await ctx.db
      .insert(users)
      .values({
        tenant_id,
        email: "rules-key-member@example.test",
        role_id: await builtinRoleId(ctx.db, "member"),
      })
      .returning();
    if (!member) throw new Error("member missing");
    const key = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id,
        owner_kind: "user",
        owner_id: member.id,
        actor_id: null,
      },
      ctx.db,
    );
    const auth = { authorization: `Bearer ${key.plaintext}`, "content-type": "application/json" };
    const id = await offerFor(tenant_id, member.id, "partner@example.com");
    const listed = await call("GET", "/v1/approval-rules?state=offered", auth);
    expect((listed.body.items as Array<{ id: string }>).map((rule) => rule.id)).toEqual([id]);
    const refused = await call("POST", `/v1/approval-rules/${id}/accept`, auth);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "human_confirmation_required" });
    const renewal = await call("POST", `/v1/approval-rules/${id}/renew`, auth);
    expect(renewal.status).toBe(403);
    expect(renewal.body).toMatchObject({ code: "human_confirmation_required" });
    const still = await call("GET", "/v1/approval-rules?state=offered", auth);
    expect((still.body.items as unknown[]).length).toBe(1);
  });
});
