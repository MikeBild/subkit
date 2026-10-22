import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { encryptSecret } from "../crypto/aes-gcm.ts";
import type { Db } from "../db/client.ts";
import { cockpitInstallations } from "../db/schema/cockpit-installations.ts";
import { cockpitPushKeys, cockpitPushSubscriptions } from "../db/schema/cockpit-push.ts";
import { sessions, users } from "../db/schema/identity.ts";
import { builtinRoleId } from "../rbac/roles.ts";

const HOUR_MS = 60 * 60_000;

export interface CockpitPushFixture {
  tenantId: string;
  installationId: string | null;
  sessionId: string;
  userId: string;
  subscriptionId: string;
  endpoint: string;
}

export function createCockpitPushFixtures(input: { db: Db; at: Date; nextUuid: () => string }) {
  let endpointSequence = 0;
  const { db, at, nextUuid } = input;

  const prepareKey = async (tenantId: string) => {
    const key = encryptSecret(
      JSON.stringify({ publicKey: "public-key", privateKey: "private-key" }),
      `cockpit-push-key:${tenantId}`,
    );
    await db.insert(cockpitPushKeys).values({ tenant_id: tenantId, ...key });
  };

  const user = async (tenantId: string, role: "admin" | "member" = "member") => {
    const [row] = await db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: `push-${role}-${nextUuid()}@test.local`,
        role_id: await builtinRoleId(db, role),
      })
      .returning({ id: users.id });
    if (!row) throw new Error("missing push user fixture");
    return row.id;
  };

  const installation = async (
    tenantId: string,
    options: { userId?: string; role?: "admin" | "member" } = {},
  ): Promise<CockpitPushFixture> => {
    const userId = options.userId ?? (await user(tenantId, options.role));
    const installationId = nextUuid();
    await db
      .insert(cockpitInstallations)
      .values({ id: installationId, tenant_id: tenantId, owner_user_id: userId });
    const sessionId = nextUuid();
    await db.insert(sessions).values({
      id: sessionId,
      tenant_id: tenantId,
      user_id: userId,
      installation_id: installationId,
      expires_at: new Date(at.getTime() + HOUR_MS),
      absolute_expires_at: new Date(at.getTime() + HOUR_MS),
      last_seen_at: at,
      created_at: at,
    });
    const endpoint = `https://fcm.googleapis.com/fcm/send/attention-${++endpointSequence}`;
    const hash = createHash("sha256").update(endpoint).digest("hex");
    const encrypted = encryptSecret(
      JSON.stringify({ endpoint, keys: { p256dh: "a".repeat(64), auth: "b".repeat(16) } }),
      `cockpit-push-subscription:${tenantId}:${installationId}:${sessionId}:${hash}`,
    );
    const [row] = await db
      .insert(cockpitPushSubscriptions)
      .values({
        tenant_id: tenantId,
        installation_id: installationId,
        session_id: sessionId,
        endpoint_sha256: hash,
        ...encrypted,
      })
      .returning({ id: cockpitPushSubscriptions.id });
    if (!row) throw new Error("missing push subscription fixture");
    return { tenantId, installationId, sessionId, userId, subscriptionId: row.id, endpoint };
  };

  const deviceHash = (tenantId: string, userId: string, device: string) =>
    createHash("sha256").update(`${tenantId}:${userId}:${device}`).digest("hex");

  const browser = async (
    tenantId: string,
    options: { userId?: string; device?: string; role?: "admin" | "member" } = {},
  ): Promise<CockpitPushFixture> => {
    const userId = options.userId ?? (await user(tenantId, options.role));
    const sessionId = nextUuid();
    await db.insert(sessions).values({
      id: sessionId,
      tenant_id: tenantId,
      user_id: userId,
      expires_at: new Date(at.getTime() + HOUR_MS),
      absolute_expires_at: new Date(at.getTime() + HOUR_MS),
      last_seen_at: at,
      created_at: at,
    });
    const endpoint = `https://fcm.googleapis.com/fcm/send/browser-attention-${++endpointSequence}`;
    const hash = createHash("sha256").update(endpoint).digest("hex");
    const encrypted = encryptSecret(
      JSON.stringify({ endpoint, keys: { p256dh: "a".repeat(64), auth: "b".repeat(16) } }),
      `cockpit-push-browser-subscription:${tenantId}:${userId}:${hash}`,
    );
    const [row] = await db
      .insert(cockpitPushSubscriptions)
      .values({
        tenant_id: tenantId,
        kind: "browser",
        user_id: userId,
        session_id: sessionId,
        endpoint_sha256: hash,
        device_sha256: options.device ? deviceHash(tenantId, userId, options.device) : null,
        ...encrypted,
      })
      .returning({ id: cockpitPushSubscriptions.id });
    if (!row) throw new Error("missing browser push subscription fixture");
    return { tenantId, installationId: null, sessionId, userId, subscriptionId: row.id, endpoint };
  };

  const onDevice = async (fixture: CockpitPushFixture, device: string) => {
    await db
      .update(cockpitPushSubscriptions)
      .set({ device_sha256: deviceHash(fixture.tenantId, fixture.userId, device) })
      .where(
        and(
          eq(cockpitPushSubscriptions.tenant_id, fixture.tenantId),
          eq(cockpitPushSubscriptions.id, fixture.subscriptionId),
        ),
      );
  };

  const storedKeys = async (fixture: CockpitPushFixture) => {
    const [row] = await db
      .select({ keys: cockpitPushSubscriptions.notified_attention_keys })
      .from(cockpitPushSubscriptions)
      .where(
        and(
          eq(cockpitPushSubscriptions.tenant_id, fixture.tenantId),
          eq(cockpitPushSubscriptions.id, fixture.subscriptionId),
        ),
      );
    return row?.keys ?? null;
  };

  return { prepareKey, user, installation, browser, onDevice, storedKeys };
}

export function recordingPushSender() {
  const sent: string[] = [];
  const send = async (subscription: { endpoint: string }) => {
    sent.push(subscription.endpoint);
    return {} as never;
  };
  return { sent, send: send as never };
}
