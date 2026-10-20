import { createHash, ECDH } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import webpush from "web-push";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertEgressAllowedResolved } from "../connectors/index.ts";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";
import type { Db, Executor } from "../db/client.ts";
import { cockpitInstallations } from "../db/schema/cockpit-installations.ts";
import { cockpitPushKeys, cockpitPushSubscriptions } from "../db/schema/cockpit-push.ts";
import { sessions, tenants, users } from "../db/schema/identity.ts";

const PUSH_AUDIENCE_MAX = 20;
const PUSH_ENDPOINT_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);
const NEUTRAL_PUSH_PAYLOAD = JSON.stringify({
  title: "SubKit",
  body: "Attention required",
  tag: "subkit-attention",
  data: {},
});

export interface CockpitPushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface CockpitPushContext {
  installation_id: string;
  tenant_id: string;
  user_id: string;
  session_id: string;
  expires_at: Date | null;
}

interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

function keyAad(tenantId: string): string {
  return `cockpit-push-key:${tenantId}`;
}

function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

function subscriptionAad(context: CockpitPushContext, hash: string): string {
  return `cockpit-push-subscription:${context.tenant_id}:${context.installation_id}:${context.session_id}:${hash}`;
}

function isPushEndpointHost(host: string): boolean {
  return (
    PUSH_ENDPOINT_HOSTS.has(host) ||
    host.endsWith(".push.apple.com") ||
    host.endsWith(".notify.windows.com")
  );
}

export function parseCockpitPushEndpoint(endpoint: string): URL {
  const value = new URL(endpoint);
  if (
    value.protocol !== "https:" ||
    value.username ||
    value.password ||
    value.port ||
    value.hash ||
    !isPushEndpointHost(value.hostname.toLowerCase())
  ) {
    throw new TypeError("cockpit push endpoint is not permitted");
  }
  return value;
}

function activeSessionWhere(
  context: Pick<CockpitPushContext, "tenant_id" | "installation_id"> & { session_id?: string },
  now: Date,
) {
  return and(
    eq(cockpitPushSubscriptions.tenant_id, context.tenant_id),
    eq(cockpitPushSubscriptions.installation_id, context.installation_id),
    ...(context.session_id ? [eq(cockpitPushSubscriptions.session_id, context.session_id)] : []),
    eq(sessions.tenant_id, context.tenant_id),
    eq(sessions.installation_id, context.installation_id),
    isNull(sessions.revoked_at),
    gt(sessions.expires_at, now),
    or(isNull(sessions.absolute_expires_at), gt(sessions.absolute_expires_at, now)),
    eq(cockpitInstallations.tenant_id, context.tenant_id),
    eq(cockpitInstallations.owner_user_id, sessions.user_id),
    isNull(cockpitInstallations.revoked_at),
    eq(users.tenant_id, context.tenant_id),
    eq(users.id, sessions.user_id),
    eq(users.status, "active"),
    isNull(users.deleted_at),
    eq(tenants.id, context.tenant_id),
    eq(tenants.status, "active"),
    isNull(tenants.deleted_at),
  );
}

function parseKeyPair(raw: string): VapidKeyPair {
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as Record<string, unknown>).publicKey !== "string" ||
    typeof (value as Record<string, unknown>).privateKey !== "string"
  )
    throw new Error("cockpit push key is invalid");
  return value as VapidKeyPair;
}

function parseSubscription(raw: string): CockpitPushSubscriptionInput {
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as Record<string, unknown>).endpoint !== "string" ||
    !(value as Record<string, unknown>).keys ||
    typeof (value as Record<string, unknown>).keys !== "object" ||
    typeof (value as { keys: Record<string, unknown> }).keys.p256dh !== "string" ||
    typeof (value as { keys: Record<string, unknown> }).keys.auth !== "string"
  )
    throw new Error("cockpit push subscription is invalid");
  return value as CockpitPushSubscriptionInput;
}

export async function prepareCockpitPushKey(db: Db, context: CockpitPushContext): Promise<string> {
  const [existing] = await db
    .select({
      ciphertext: cockpitPushKeys.ciphertext,
      iv: cockpitPushKeys.iv,
      auth_tag: cockpitPushKeys.auth_tag,
    })
    .from(cockpitPushKeys)
    .where(eq(cockpitPushKeys.tenant_id, context.tenant_id))
    .limit(1);
  if (existing) return parseKeyPair(decryptSecret(existing, keyAad(context.tenant_id))).publicKey;

  const keys = webpush.generateVAPIDKeys();
  const encrypted = encryptSecret(JSON.stringify(keys), keyAad(context.tenant_id));
  const inserted = await db
    .insert(cockpitPushKeys)
    .values({ tenant_id: context.tenant_id, ...encrypted })
    .onConflictDoNothing()
    .returning({ tenant_id: cockpitPushKeys.tenant_id });
  if (inserted.length === 0) return await prepareCockpitPushKey(db, context);
  await auditAwait(
    {
      tenant_id: context.tenant_id,
      actor_type: "user",
      actor_id: context.user_id,
      action: AuditAction.COCKPIT_PUSH_KEY_PREPARED,
      resource_type: "cockpit_push_key",
      resource_id: context.tenant_id,
      result: "success",
      metadata: { installation_id: context.installation_id, session_id: context.session_id },
    },
    db,
  );
  return keys.publicKey;
}

export async function upsertCockpitPushSubscription(
  db: Db,
  context: CockpitPushContext,
  subscription: CockpitPushSubscriptionInput,
): Promise<void> {
  const publicKey = Buffer.from(subscription.keys.p256dh, "base64url");
  const auth = Buffer.from(subscription.keys.auth, "base64url");
  if (
    publicKey.length !== 65 ||
    publicKey[0] !== 4 ||
    auth.length !== 16 ||
    publicKey.toString("base64url") !== subscription.keys.p256dh ||
    auth.toString("base64url") !== subscription.keys.auth
  )
    throw new TypeError("invalid push key material");
  try {
    ECDH.convertKey(publicKey, "prime256v1");
  } catch {
    throw new TypeError("invalid push key material");
  }
  const endpoint = parseCockpitPushEndpoint(subscription.endpoint);
  await assertEgressAllowedResolved(endpoint, { tenant_id: context.tenant_id, exec: db });
  const hash = endpointHash(subscription.endpoint);
  const encrypted = encryptSecret(JSON.stringify(subscription), subscriptionAad(context, hash));
  await db
    .insert(cockpitPushSubscriptions)
    .values({
      tenant_id: context.tenant_id,
      installation_id: context.installation_id,
      session_id: context.session_id,
      endpoint_sha256: hash,
      ...encrypted,
    })
    .onConflictDoUpdate({
      target: [cockpitPushSubscriptions.installation_id, cockpitPushSubscriptions.session_id],
      set: { endpoint_sha256: hash, ...encrypted, updated_at: new Date() },
    });
  await auditAwait(
    {
      tenant_id: context.tenant_id,
      actor_type: "user",
      actor_id: context.user_id,
      action: AuditAction.COCKPIT_PUSH_SUBSCRIPTION_UPSERTED,
      resource_type: "cockpit_push_subscription",
      resource_id: context.session_id,
      result: "success",
      metadata: { installation_id: context.installation_id },
    },
    db,
  );
}

export async function removeCockpitPushSubscription(
  db: Db,
  context: CockpitPushContext,
): Promise<boolean> {
  const removed = await db
    .delete(cockpitPushSubscriptions)
    .where(
      and(
        eq(cockpitPushSubscriptions.tenant_id, context.tenant_id),
        eq(cockpitPushSubscriptions.installation_id, context.installation_id),
        eq(cockpitPushSubscriptions.session_id, context.session_id),
      ),
    )
    .returning({ id: cockpitPushSubscriptions.id });
  if (removed.length === 0) return false;
  await auditAwait(
    {
      tenant_id: context.tenant_id,
      actor_type: "user",
      actor_id: context.user_id,
      action: AuditAction.COCKPIT_PUSH_SUBSCRIPTION_REMOVED,
      resource_type: "cockpit_push_subscription",
      resource_id: context.session_id,
      result: "success",
      metadata: { installation_id: context.installation_id },
    },
    db,
  );
  return true;
}

export async function cockpitPushSubscriptionActive(
  db: Executor,
  context: CockpitPushContext,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .select({ id: cockpitPushSubscriptions.id })
    .from(cockpitPushSubscriptions)
    .innerJoin(sessions, eq(sessions.id, cockpitPushSubscriptions.session_id))
    .innerJoin(
      cockpitInstallations,
      eq(cockpitInstallations.id, cockpitPushSubscriptions.installation_id),
    )
    .innerJoin(users, eq(users.id, sessions.user_id))
    .innerJoin(tenants, eq(tenants.id, sessions.tenant_id))
    .where(activeSessionWhere(context, now))
    .limit(1);
  return rows.length > 0;
}

export async function sendCockpitPushNotifications(input: {
  db: Db;
  tenant_id: string;
  installation_id: string;
  subject: string;
  send?: typeof webpush.sendNotification;
}): Promise<{ attempted: number; delivered: number }> {
  const subject = new URL(input.subject);
  if (subject.protocol !== "https:" || subject.username || subject.password)
    throw new Error("cockpit push subject must be an HTTPS URL without credentials");
  const now = new Date();
  const keyRows = await input.db
    .select({
      ciphertext: cockpitPushKeys.ciphertext,
      iv: cockpitPushKeys.iv,
      auth_tag: cockpitPushKeys.auth_tag,
    })
    .from(cockpitPushKeys)
    .where(eq(cockpitPushKeys.tenant_id, input.tenant_id))
    .limit(1);
  const key = keyRows[0];
  if (!key) return { attempted: 0, delivered: 0 };
  const vapid = parseKeyPair(decryptSecret(key, keyAad(input.tenant_id)));
  const rows = await input.db
    .select({
      id: cockpitPushSubscriptions.id,
      endpoint_sha256: cockpitPushSubscriptions.endpoint_sha256,
      ciphertext: cockpitPushSubscriptions.ciphertext,
      iv: cockpitPushSubscriptions.iv,
      auth_tag: cockpitPushSubscriptions.auth_tag,
      installation_id: cockpitPushSubscriptions.installation_id,
      session_id: cockpitPushSubscriptions.session_id,
      tenant_id: cockpitPushSubscriptions.tenant_id,
    })
    .from(cockpitPushSubscriptions)
    .innerJoin(sessions, eq(sessions.id, cockpitPushSubscriptions.session_id))
    .innerJoin(
      cockpitInstallations,
      eq(cockpitInstallations.id, cockpitPushSubscriptions.installation_id),
    )
    .innerJoin(users, eq(users.id, sessions.user_id))
    .innerJoin(tenants, eq(tenants.id, sessions.tenant_id))
    .where(
      activeSessionWhere(
        {
          tenant_id: input.tenant_id,
          installation_id: input.installation_id,
        },
        now,
      ),
    )
    .limit(PUSH_AUDIENCE_MAX);
  let delivered = 0;
  for (const row of rows) {
    const context: CockpitPushContext = {
      installation_id: row.installation_id,
      tenant_id: row.tenant_id,
      user_id: "",
      session_id: row.session_id,
      expires_at: now,
    };
    try {
      const live = await input.db
        .select({ id: cockpitPushSubscriptions.id })
        .from(cockpitPushSubscriptions)
        .innerJoin(sessions, eq(sessions.id, cockpitPushSubscriptions.session_id))
        .innerJoin(
          cockpitInstallations,
          eq(cockpitInstallations.id, cockpitPushSubscriptions.installation_id),
        )
        .innerJoin(users, eq(users.id, sessions.user_id))
        .innerJoin(tenants, eq(tenants.id, sessions.tenant_id))
        .where(activeSessionWhere(context, new Date()))
        .limit(1);
      if (live.length === 0) continue;
      const subscription = parseSubscription(
        decryptSecret(row, subscriptionAad(context, row.endpoint_sha256)),
      );
      const endpoint = parseCockpitPushEndpoint(subscription.endpoint);
      await assertEgressAllowedResolved(endpoint, {
        tenant_id: input.tenant_id,
        exec: input.db,
      });
      await (input.send ?? webpush.sendNotification)(subscription, NEUTRAL_PUSH_PAYLOAD, {
        vapidDetails: {
          subject: input.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
        TTL: 60,
        urgency: "normal",
      });
      delivered += 1;
    } catch (error) {
      const statusCode =
        typeof error === "object" && error !== null && "statusCode" in error
          ? (error as { statusCode?: unknown }).statusCode
          : undefined;
      if (statusCode === 404 || statusCode === 410) {
        const removed = await input.db
          .delete(cockpitPushSubscriptions)
          .where(
            and(
              eq(cockpitPushSubscriptions.id, row.id),
              eq(cockpitPushSubscriptions.tenant_id, input.tenant_id),
            ),
          )
          .returning({ id: cockpitPushSubscriptions.id });
        if (removed.length > 0)
          await auditAwait(
            {
              tenant_id: input.tenant_id,
              actor_type: "system",
              action: AuditAction.COCKPIT_PUSH_SUBSCRIPTION_REMOVED,
              resource_type: "cockpit_push_subscription",
              resource_id: row.session_id,
              result: "success",
              metadata: { installation_id: input.installation_id, reason: "endpoint_gone" },
            },
            input.db,
          );
      }
    }
  }
  return { attempted: rows.length, delivered };
}

export async function sendCockpitPushAttention(input: {
  db: Db;
  tenant_id: string;
  subject: string;
}): Promise<{ attempted: number; delivered: number }> {
  const rows = await input.db
    .select({ installation_id: cockpitPushSubscriptions.installation_id })
    .from(cockpitPushSubscriptions)
    .innerJoin(
      cockpitInstallations,
      eq(cockpitInstallations.id, cockpitPushSubscriptions.installation_id),
    )
    .where(
      and(
        eq(cockpitPushSubscriptions.tenant_id, input.tenant_id),
        isNull(cockpitInstallations.revoked_at),
        eq(cockpitInstallations.tenant_id, input.tenant_id),
      ),
    )
    .limit(PUSH_AUDIENCE_MAX);
  const installationIds = [...new Set(rows.map((row) => row.installation_id))];
  let attempted = 0;
  let delivered = 0;
  for (const installation_id of installationIds) {
    const result = await sendCockpitPushNotifications({ ...input, installation_id });
    attempted += result.attempted;
    delivered += result.delivered;
  }
  return { attempted, delivered };
}
