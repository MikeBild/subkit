import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../audit/types.ts";
import {
  auditLog,
  conversations,
  transactionalMailReceipts,
  userInvites,
  users,
} from "../../../db/schema/index.ts";
import { createInvitedUser } from "../../../identity/provisioning.ts";
import { issueApiKey } from "../../../identity/service.ts";
import { activeApprover } from "../../../identity/setup-preferences.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { ctx, login, setupBrowserMemberships } from "../../tests/memberships-fixtures.ts";

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

async function getSetup(auth: Record<string, string>) {
  const response = await fetch(`${ctx.baseUrl}/v1/identity/me/setup`, { headers: auth });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function putSetup(auth: Record<string, string>, body: unknown) {
  const response = await fetch(`${ctx.baseUrl}/v1/identity/me/setup`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function memberOf(tenant_id: string, label: string) {
  const [member] = await ctx.db
    .select()
    .from(users)
    .where(and(eq(users.tenant_id, tenant_id), eq(users.email, `${label}@example.test`)));
  if (!member) throw new Error("member missing");
  return member;
}

async function memberKey(tenant_id: string, label: string) {
  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id,
      email: `${label}@example.test`,
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
  return {
    member,
    auth: { authorization: `Bearer ${key.plaintext}`, "content-type": "application/json" },
  };
}

describe("setup choices of the signed-in person", () => {
  test("an untouched setup answers with the recommended values and names them as unset", async () => {
    const owner = await login("setup-fresh");
    const { status, body } = await getSetup(headers(owner));
    expect(status).toBe(200);
    expect(body).toEqual({
      default_chat_mode: "auto",
      default_environment: "dev",
      approver: { kind: "self" },
      notifications: { mode: "immediately" },
      timezone: null,
      critical_breakthrough: false,
      first_job: null,
      services: [],
      unset: ["default_chat_mode", "default_environment", "approver", "notifications"],
      recommended: {
        default_chat_mode: "auto",
        default_environment: "dev",
        approver: { kind: "self" },
        notifications: { mode: "immediately" },
        critical_breakthrough: false,
      },
      updated_at: null,
    });
  });

  test("choices are stored field by field, read back and audited", async () => {
    const owner = await login("setup-writer");
    const first = await putSetup(headers(owner), {
      default_chat_mode: "ask",
      default_environment: "prod",
      notifications: { mode: "working_hours", from: "08:00", to: "17:30" },
      first_job: "weekly-report",
      services: ["gmail", "slack", "gmail"],
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      default_chat_mode: "ask",
      default_environment: "prod",
      approver: { kind: "self" },
      notifications: { mode: "working_hours", from: "08:00", to: "17:30" },
      first_job: "weekly-report",
      services: ["gmail", "slack"],
      unset: ["approver"],
    });
    const second = await putSetup(headers(owner), {
      approver: { kind: "self" },
      notifications: { mode: "daily_digest", at: "07:15" },
    });
    expect(second.body).toMatchObject({
      default_chat_mode: "ask",
      default_environment: "prod",
      notifications: { mode: "daily_digest", at: "07:15" },
      first_job: "weekly-report",
      unset: [],
    });
    expect((await getSetup(headers(owner))).body).toMatchObject({
      default_chat_mode: "ask",
      notifications: { mode: "daily_digest", at: "07:15" },
      services: ["gmail", "slack"],
    });
    const entries = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, owner.payload.tenant_id),
          eq(auditLog.action, AuditAction.USER_SETUP_UPDATED),
        ),
      );
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.actor_id === owner.payload.user_id)).toBe(true);
  });

  test("the time zone and the opt-in for critical items are stored, an unknown zone is refused", async () => {
    const owner = await login("setup-quiet");
    const stored = await putSetup(headers(owner), {
      notifications: { mode: "daily_digest", at: "07:30" },
      timezone: "Europe/Berlin",
      critical_breakthrough: true,
    });
    expect(stored.status).toBe(200);
    expect(stored.body).toMatchObject({
      notifications: { mode: "daily_digest", at: "07:30" },
      timezone: "Europe/Berlin",
      critical_breakthrough: true,
    });
    expect((await putSetup(headers(owner), { timezone: "Mars/Olympus" })).status).toBe(400);
    const cleared = await putSetup(headers(owner), { timezone: null });
    expect(cleared.body).toMatchObject({ timezone: null, critical_breakthrough: true });
  });

  test("working days are stored as chosen and stay Monday to Friday when left out", async () => {
    const owner = await login("setup-weekdays");
    const weekend = { mode: "working_hours", from: "10:00", to: "14:00", days: [6, 7] };
    const stored = await putSetup(headers(owner), { notifications: weekend });
    expect(stored.status).toBe(200);
    expect(stored.body).toMatchObject({ notifications: weekend });
    const plain = { mode: "working_hours", from: "09:00", to: "17:00" };
    const defaulted = await putSetup(headers(owner), { notifications: plain });
    expect(defaulted.status).toBe(200);
    expect((defaulted.body as { notifications: unknown }).notifications).toEqual(plain);
  });

  test("values outside the closed choices are refused and nothing is stored", async () => {
    const owner = await login("setup-invalid");
    const bodies = [
      { default_chat_mode: "yolo" },
      { default_environment: "staging" },
      { notifications: { mode: "working_hours", from: "8", to: "17:00" } },
      { notifications: { mode: "working_hours", from: "08:00", to: "17:00", days: [] } },
      { notifications: { mode: "working_hours", from: "08:00", to: "17:00", days: [0] } },
      { notifications: { mode: "working_hours", from: "08:00", to: "17:00", days: [8] } },
      { notifications: { mode: "working_hours", from: "08:00", to: "17:00", days: [1, 1] } },
      { notifications: { mode: "daily_digest", at: "07:15", days: [1] } },
      { notifications: { mode: "daily_digest" } },
      { services: ["Not A Slug"] },
      { unknown_field: true },
    ];
    for (const body of bodies) {
      const refused = await putSetup(headers(owner), body);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
    }
    expect((await getSetup(headers(owner))).body.updated_at).toBeNull();
  });

  test("naming a teammate as an administrator prepares an invitation and sends no mail", async () => {
    const owner = await login("setup-approver");
    const tenant_id = owner.payload.tenant_id;
    const named = await putSetup(headers(owner), {
      approver: { kind: "teammate", email: "kollegin@example.test" },
    });
    expect(named.status).toBe(200);
    const approver = named.body.approver as Record<string, unknown>;
    const invitation = named.body.invitation as Record<string, unknown>;
    expect(approver).toMatchObject({
      kind: "teammate",
      email: "kollegin@example.test",
      invitation: "pending",
    });
    expect(typeof invitation.plaintext_token).toBe("string");
    const [teammate] = await ctx.db
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, tenant_id), eq(users.email, "kollegin@example.test")));
    expect(teammate).toMatchObject({ status: "invited", id: approver.user_id });
    const invites = await ctx.db
      .select()
      .from(userInvites)
      .where(eq(userInvites.tenant_id, tenant_id));
    expect(invites.map((invite) => invite.id)).toEqual([invitation.invite_id as string]);
    expect(
      await ctx.db
        .select()
        .from(transactionalMailReceipts)
        .where(eq(transactionalMailReceipts.tenant_id, tenant_id)),
    ).toEqual([]);

    const again = await putSetup(headers(owner), {
      approver: { kind: "teammate", email: "Kollegin@Example.test" },
    });
    expect(again.body.invitation).toBeUndefined();
    expect(again.body.approver).toMatchObject({ user_id: approver.user_id, invitation: "pending" });
    expect(
      await ctx.db.select().from(userInvites).where(eq(userInvites.tenant_id, tenant_id)),
    ).toHaveLength(1);
    const read = await getSetup(headers(owner));
    expect(read.body.invitation).toBeUndefined();
    expect(read.body.approver).toMatchObject({ email: "kollegin@example.test" });
  });

  test("a member without the right to invite stores the wish and creates nobody", async () => {
    const owner = await login("setup-member-owner");
    const tenant_id = owner.payload.tenant_id;
    const { member, auth } = await memberKey(tenant_id, "setup-member");
    const before = (await ctx.db.select().from(users).where(eq(users.tenant_id, tenant_id))).length;
    const named = await putSetup(auth, {
      approver: { kind: "teammate", email: "noch-nicht-da@example.test" },
    });
    expect(named.status).toBe(200);
    expect(named.body.approver).toEqual({
      kind: "teammate",
      email: "noch-nicht-da@example.test",
      user_id: null,
      invite_id: null,
      invitation: "needs_admin",
      can_approve: null,
      missing_permissions: [],
    });
    expect(named.body.invitation).toBeUndefined();
    expect(await ctx.db.select().from(users).where(eq(users.tenant_id, tenant_id))).toHaveLength(
      before,
    );
    const existing = await putSetup(auth, {
      approver: { kind: "teammate", email: "setup-member-owner@example.test" },
    });
    expect(existing.body.approver).toMatchObject({
      user_id: owner.payload.user_id,
      invitation: "member",
      can_approve: true,
      missing_permissions: [],
    });
    const self = await putSetup(auth, { approver: { kind: "teammate", email: member.email } });
    expect(self.body.approver).toEqual({ kind: "self" });
    expect((await getSetup(headers(owner))).body.unset).toContain("approver");
  });

  test("the invitation for an approver carries the member role, which may approve", async () => {
    const owner = await login("setup-approver-role");
    const tenant_id = owner.payload.tenant_id;
    const named = await putSetup(headers(owner), {
      approver: { kind: "teammate", email: "freigabe@example.test" },
    });
    expect(named.body.approver).toMatchObject({
      invitation: "pending",
      can_approve: true,
      missing_permissions: [],
    });
    const [teammate] = await ctx.db
      .select({ role_id: users.role_id })
      .from(users)
      .where(and(eq(users.tenant_id, tenant_id), eq(users.email, "freigabe@example.test")));
    expect(teammate?.role_id).toBe(await builtinRoleId(ctx.db, "member"));
  });

  test("a teammate whose role cannot approve is stored with a warning", async () => {
    const owner = await login("setup-approver-weak");
    const tenant_id = owner.payload.tenant_id;
    await ctx.db.insert(users).values({
      tenant_id,
      email: "nur-lesen@example.test",
      role_id: await builtinRoleId(ctx.db, "enduser"),
    });
    const named = await putSetup(headers(owner), {
      approver: { kind: "teammate", email: "nur-lesen@example.test" },
    });
    expect(named.status).toBe(200);
    expect(named.body.approver).toMatchObject({
      invitation: "member",
      can_approve: false,
      missing_permissions: ["conversation:approve", "task:grant", "workflow:write"],
    });
    expect((await getSetup(headers(owner))).body.approver).toMatchObject({ can_approve: false });
  });

  test("an approver who was not in the workspace is linked once that person joins", async () => {
    const owner = await login("setup-approver-late");
    const tenant_id = owner.payload.tenant_id;
    const { auth } = await memberKey(tenant_id, "setup-late-member");
    const wished = await putSetup(auth, {
      approver: { kind: "teammate", email: "Spaeter@Example.test" },
    });
    expect(wished.body.approver).toMatchObject({ invitation: "needs_admin", user_id: null });
    const invited = await createInvitedUser(
      {
        tenant_id,
        email: "spaeter@example.test",
        role: "member",
        actor_kind: "user",
        actor_id: owner.payload.user_id,
        issuer: { kind: "system" },
      },
      ctx.db,
    );
    const pending = await getSetup(auth);
    expect(pending.body.approver).toMatchObject({
      invitation: "pending",
      user_id: invited.user.id,
      can_approve: true,
    });
    await ctx.db
      .update(users)
      .set({ status: "active" })
      .where(and(eq(users.tenant_id, tenant_id), eq(users.id, invited.user.id)));
    expect(
      await activeApprover(ctx.db, {
        tenant_id,
        user_id: (await memberOf(tenant_id, "setup-late-member")).id,
      }),
    ).toMatchObject({ user_id: invited.user.id });
    expect((await getSetup(auth)).body.approver).toMatchObject({
      invitation: "member",
      user_id: invited.user.id,
    });
    const linked = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, AuditAction.USER_SETUP_UPDATED)),
      );
    expect(
      linked.some(
        (entry) => (entry.metadata as { source?: string } | null)?.source === "approver_joined",
      ),
    ).toBe(true);
  });

  test("a new conversation starts in the stored mode unless the client names one", async () => {
    const owner = await login("setup-chat-mode");
    const create = async (body: unknown) => {
      const response = await fetch(`${ctx.baseUrl}/v1/conversations`, {
        method: "POST",
        headers: headers(owner),
        body: JSON.stringify(body),
      });
      expect(response.status).toBeLessThan(300);
      const created = (await response.json()) as { conversation?: { id: string }; id?: string };
      const id = created.conversation?.id ?? created.id;
      if (!id) throw new Error("conversation id missing");
      const [row] = await ctx.db.select().from(conversations).where(eq(conversations.id, id));
      return (row?.draft as { session?: { permission_mode?: string } } | null)?.session
        ?.permission_mode;
    };
    expect(await create({})).toBe("auto");
    await putSetup(headers(owner), { default_chat_mode: "ask" });
    expect(await create({})).toBe("ask");
    expect(await create({ permission_mode: "plan" })).toBe("plan");
    await putSetup(headers(owner), { default_chat_mode: "plan" });
    expect(await create({})).toBe("plan");
  });
});
