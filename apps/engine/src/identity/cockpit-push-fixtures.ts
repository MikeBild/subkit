import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { encryptSecret } from "../crypto/aes-gcm.ts";
import { auditLog } from "../db/schema/audit.ts";
import { cockpitInstallations } from "../db/schema/cockpit-installations.ts";
import { cockpitPushSubscriptions } from "../db/schema/cockpit-push.ts";
import { sessions, users } from "../db/schema/identity.ts";
import type { HttpTestServer } from "../http/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";

export const HOUR_MS = 60 * 60_000;

export const SUBJECT = "https://subkit.example";

export interface PushFixture {
  installationId: string;
  sessionId: string;
  userId: string;
  subscriptionId: string;
  endpoint: string;
}

export function recordingSender() {
  const sent: Array<{ endpoint: string; payload: string; subject: string | undefined }> = [];
  const send = async (
    subscription: { endpoint: string },
    payload?: string | Buffer | null,
    options?: { vapidDetails?: { subject?: string } },
  ) => {
    sent.push({
      endpoint: subscription.endpoint,
      payload: String(payload),
      subject: options?.vapidDetails?.subject,
    });
    return {} as never;
  };
  return { sent, send };
}

export function cockpitPushFixtures(state: { readonly ctx: HttpTestServer; readonly at: Date }) {
  const nextUuid = createDeterministicUuidFactory(0xc0c1);

  let endpointSequence = 0;

  async function memberUser(): Promise<string> {
    const [user] = await state.ctx.db
      .insert(users)
      .values({
        tenant_id: state.ctx.tenantId,
        email: `push-member-${nextUuid()}@test.local`,
        role_id: await builtinRoleId(state.ctx.db, "member"),
      })
      .returning({ id: users.id });
    if (!user) throw new Error("missing push member fixture");
    return user.id;
  }

  async function addSession(input: {
    installationId: string;
    userId: string;
    lastSeenAt?: Date | null;
    expired?: boolean;
  }): Promise<string> {
    const id = nextUuid();
    await state.ctx.db.insert(sessions).values({
      id,
      tenant_id: state.ctx.tenantId,
      user_id: input.userId,
      installation_id: input.installationId,
      expires_at: new Date(state.at.getTime() + (input.expired ? -HOUR_MS : HOUR_MS)),
      absolute_expires_at: new Date(state.at.getTime() + (input.expired ? -HOUR_MS : HOUR_MS)),
      last_seen_at: input.lastSeenAt === undefined ? state.at : input.lastSeenAt,
      created_at: input.lastSeenAt ?? state.at,
    });
    return id;
  }

  async function addSubscription(input: {
    installationId: string;
    sessionId: string;
    endpoint?: string;
  }): Promise<{ id: string; endpoint: string }> {
    const endpoint =
      input.endpoint ?? `https://fcm.googleapis.com/fcm/send/fixture-${++endpointSequence}`;
    const hash = createHash("sha256").update(endpoint).digest("hex");
    const encrypted = encryptSecret(
      JSON.stringify({ endpoint, keys: { p256dh: "a".repeat(64), auth: "b".repeat(16) } }),
      `cockpit-push-subscription:${state.ctx.tenantId}:${input.installationId}:${input.sessionId}:${hash}`,
    );
    const [row] = await state.ctx.db
      .insert(cockpitPushSubscriptions)
      .values({
        tenant_id: state.ctx.tenantId,
        installation_id: input.installationId,
        session_id: input.sessionId,
        endpoint_sha256: hash,
        ...encrypted,
      })
      .returning({ id: cockpitPushSubscriptions.id });
    if (!row) throw new Error("missing push subscription fixture");
    return { id: row.id, endpoint };
  }

  async function pushFixture(
    input: { userId?: string; lastSeenAt?: Date | null; expired?: boolean } = {},
  ): Promise<PushFixture> {
    const userId = input.userId ?? (await memberUser());
    const installationId = nextUuid();
    await state.ctx.db.insert(cockpitInstallations).values({
      id: installationId,
      tenant_id: state.ctx.tenantId,
      owner_user_id: userId,
    });
    const sessionId = await addSession({
      installationId,
      userId,
      ...(input.lastSeenAt !== undefined ? { lastSeenAt: input.lastSeenAt } : {}),
      ...(input.expired ? { expired: true } : {}),
    });
    const subscription = await addSubscription({ installationId, sessionId });
    return {
      installationId,
      sessionId,
      userId,
      subscriptionId: subscription.id,
      endpoint: subscription.endpoint,
    };
  }

  async function removalAudits(reason: string) {
    return await state.ctx.db
      .select({ reason: auditLog.reason, metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, state.ctx.tenantId),
          eq(auditLog.action, "cockpit_push.subscription_removed"),
          eq(auditLog.reason, reason),
        ),
      );
  }

  return { addSession, memberUser, nextUuid, pushFixture, removalAudits };
}
