import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { resetInviteSendLimiters } from "../../../api/operations/identity-invite-send.ts";
import { AuditAction } from "../../../audit/types.ts";
import { createDesktopLoginRateLimiter } from "../../../auth/index.ts";
import { setConfigKey } from "../../../config/loader.ts";
import { auditLog, userInvites, users } from "../../../db/schema/index.ts";
import { type InviteMail, useInviteMailTransport } from "../../../identity/invite-delivery.ts";
import { createInvitedUser } from "../../../identity/provisioning.ts";
import { issueApiKey } from "../../../identity/service.ts";
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

async function send(auth: Record<string, string>, user_id: string, body: unknown = {}) {
  const response = await fetch(`${ctx.baseUrl}/v1/identity/users/${user_id}/invites/send`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function invite(owner: Session, label: string) {
  return createInvitedUser(
    {
      tenant_id: owner.payload.tenant_id,
      email: `${label}@example.test`,
      role: "member",
      actor_kind: "user",
      actor_id: owner.payload.user_id,
      issuer: { kind: "system" },
    },
    ctx.db,
  );
}

afterEach(() => {
  useInviteMailTransport(null);
  resetInviteSendLimiters();
});

describe("sending an invitation", () => {
  test("without a mail transport the answer is the link to copy, never a sent claim", async () => {
    const owner = await login("invite-send-copy");
    const invited = await invite(owner, "anna-copy");
    const sent = await send(headers(owner), invited.user.id);
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      delivery: "copy_link",
      reason: "no_mail_transport",
      invite: { user_id: invited.user.id, revoked_at: null },
    });
    const token = String(sent.body.plaintext_token);
    expect(sent.body.link_path).toBe(`/cockpit/invite#${token}`);
    expect(String(sent.body.url)).toEndWith(`/cockpit/invite#${token}`);

    const [old] = await ctx.db
      .select({ revoked_at: userInvites.revoked_at })
      .from(userInvites)
      .where(eq(userInvites.id, invited.invite.view.id));
    expect(old?.revoked_at).not.toBeNull();

    const [entry] = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, owner.payload.tenant_id),
          eq(auditLog.action, AuditAction.USER_INVITE_DELIVERY),
        ),
      );
    expect(entry).toMatchObject({ result: "success", reason: "no_mail_transport" });
    expect(entry?.metadata).toMatchObject({
      delivery: "copy_link",
      replaced_invite_id: invited.invite.view.id,
    });
  });

  test("with a transport the mail carries the link and the address is masked", async () => {
    const owner = await login("invite-send-mail");
    const invited = await invite(owner, "bert-mail");
    const outbox: InviteMail[] = [];
    useInviteMailTransport({
      channel: "email",
      async send(mail) {
        outbox.push(mail);
        return { ok: true };
      },
    });
    const sent = await send(headers(owner), invited.user.id);
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ delivery: "sent", channel: "email" });
    expect(sent.body.plaintext_token).toBeUndefined();
    expect(String(sent.body.to)).not.toBe("bert-mail@example.test");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.to).toBe("bert-mail@example.test");
    expect(outbox[0]?.url).toContain("/cockpit/invite#");
  });

  test("a failing transport falls back to the link and says so", async () => {
    const owner = await login("invite-send-fail");
    const invited = await invite(owner, "cora-fail");
    useInviteMailTransport({ channel: "email", send: async () => ({ ok: false }) });
    const sent = await send(headers(owner), invited.user.id);
    expect(sent.body).toMatchObject({ delivery: "copy_link", reason: "mail_failed" });
  });

  test("a mailed link never takes its address from request headers", async () => {
    const owner = await login("invite-send-nourl");
    const invited = await invite(owner, "dino-nourl");
    const outbox: InviteMail[] = [];
    useInviteMailTransport({
      channel: "email",
      async send(mail) {
        outbox.push(mail);
        return { ok: true };
      },
    });
    await setConfigKey("server.public_base_url", "");
    try {
      const sent = await send(headers(owner), invited.user.id);
      expect(sent.body).toMatchObject({ delivery: "copy_link", reason: "no_public_url" });
      expect(outbox).toHaveLength(0);
    } finally {
      await setConfigKey("server.public_base_url", ctx.baseUrl);
    }
  });

  test("a person who joined has nothing to send, and only administrators send", async () => {
    const owner = await login("invite-send-guard");
    const [joined] = await ctx.db
      .insert(users)
      .values({
        tenant_id: owner.payload.tenant_id,
        email: "joined@example.test",
        role_id: await builtinRoleId(ctx.db, "member"),
      })
      .returning();
    if (!joined) throw new Error("member missing");
    const refused = await send(headers(owner), joined.id);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("not_invited");

    const key = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: owner.payload.tenant_id,
        owner_kind: "user",
        owner_id: joined.id,
        actor_id: null,
      },
      ctx.db,
    );
    const invited = await invite(owner, "dora-guard");
    const member = await send(
      { authorization: `Bearer ${key.plaintext}`, "content-type": "application/json" },
      invited.user.id,
    );
    expect(member.status).toBe(403);
  });

  test("sending is rate limited per invited person", async () => {
    const owner = await login("invite-send-limit");
    const invited = await invite(owner, "emil-limit");
    resetInviteSendLimiters({
      issuer: {
        take: async (_db, key) =>
          createDesktopLoginRateLimiter({ max: 10, windowMs: 600_000 }).take(key),
      },
      invitee: (() => {
        const local = createDesktopLoginRateLimiter({ max: 1, windowMs: 600_000 });
        return { take: async (_db: unknown, key: string) => local.take(key) };
      })(),
    });
    expect((await send(headers(owner), invited.user.id)).status).toBe(201);
    const limited = await send(headers(owner), invited.user.id);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limit_exceeded");
  });
});
