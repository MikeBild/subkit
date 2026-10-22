import { createHash, ECDH } from "node:crypto";
import { and, asc, eq, exists, gt, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import webpush from "web-push";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { assertEgressAllowedResolved } from "../connectors/index.ts";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";
import type { Db, Executor } from "../db/client.ts";
import { cockpitInstallations } from "../db/schema/cockpit-installations.ts";
import { cockpitPushKeys, cockpitPushSubscriptions } from "../db/schema/cockpit-push.ts";
import { sessions, tenants, users } from "../db/schema/identity.ts";
import { now } from "../utils/clock.ts";

const PUSH_AUDIENCE_MAX = 200;
const PUSH_TENANTS_MAX = 200;
const PUSH_TTL_SECONDS = 4 * 60 * 60;
export const COCKPIT_PUSH_IDLE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
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
  at: Date,
) {
  return and(
    eq(cockpitPushSubscriptions.tenant_id, context.tenant_id),
    eq(cockpitPushSubscriptions.installation_id, context.installation_id),
    ...(context.session_id ? [eq(cockpitPushSubscriptions.session_id, context.session_id)] : []),
    eq(sessions.tenant_id, context.tenant_id),
    eq(sessions.installation_id, context.installation_id),
    isNull(sessions.revoked_at),
    gt(sessions.expires_at, at),
    or(isNull(sessions.absolute_expires_at), gt(sessions.absolute_expires_at, at)),
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

function pushAudienceWhere(exec: Executor, tenantScope: SQL, at: Date) {
  const recentSessions = alias(sessions, "cockpit_push_recent_sessions");
  const idleCutoff = new Date(at.getTime() - COCKPIT_PUSH_IDLE_MAX_MS);
  return and(
    tenantScope,
    eq(sessions.tenant_id, cockpitPushSubscriptions.tenant_id),
    eq(sessions.installation_id, cockpitPushSubscriptions.installation_id),
    eq(sessions.user_id, cockpitInstallations.owner_user_id),
    eq(cockpitInstallations.tenant_id, cockpitPushSubscriptions.tenant_id),
    isNull(cockpitInstallations.revoked_at),
    eq(users.tenant_id, cockpitPushSubscriptions.tenant_id),
    eq(users.status, "active"),
    isNull(users.deleted_at),
    eq(tenants.status, "active"),
    isNull(tenants.deleted_at),
    exists(
      exec
        .select({ one: sql`1` })
        .from(recentSessions)
        .where(
          and(
            eq(recentSessions.tenant_id, cockpitPushSubscriptions.tenant_id),
            eq(recentSessions.installation_id, cockpitPushSubscriptions.installation_id),
            eq(recentSessions.user_id, cockpitInstallations.owner_user_id),
            sql`coalesce(${recentSessions.last_seen_at}, ${recentSessions.created_at}) > ${idleCutoff}`,
          ),
        ),
    ),
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
  await db.transaction(async (tx) => {
    const superseded = await tx
      .delete(cockpitPushSubscriptions)
      .where(
        and(
          eq(cockpitPushSubscriptions.tenant_id, context.tenant_id),
          eq(cockpitPushSubscriptions.installation_id, context.installation_id),
          eq(cockpitPushSubscriptions.endpoint_sha256, hash),
          ne(cockpitPushSubscriptions.session_id, context.session_id),
        ),
      )
      .returning({ notified_attention_keys: cockpitPushSubscriptions.notified_attention_keys });
    const carried = superseded.find((row) => row.notified_attention_keys !== null);
    await tx
      .insert(cockpitPushSubscriptions)
      .values({
        tenant_id: context.tenant_id,
        installation_id: context.installation_id,
        session_id: context.session_id,
        endpoint_sha256: hash,
        ...encrypted,
        ...(carried ? { notified_attention_keys: carried.notified_attention_keys } : {}),
      })
      .onConflictDoUpdate({
        target: [cockpitPushSubscriptions.installation_id, cockpitPushSubscriptions.session_id],
        set: { endpoint_sha256: hash, ...encrypted, updated_at: new Date(now()) },
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
        metadata: { installation_id: context.installation_id, superseded: superseded.length },
      },
      tx,
    );
  });
}

export type CockpitPushEndReason =
  | "session_logout"
  | "session_replaced"
  | "user_deactivated"
  | "tenant_lifecycle"
  | "erasure"
  | "installation_revoked";

export type CockpitPushEndScope =
  | { tenant_id: string; session_ids: string[] }
  | { tenant_id: string; user_id: string }
  | { tenant_id: string; installation_id: string }
  | { tenant_id: string; tenant: true };

function endScopeWhere(exec: Executor, scope: CockpitPushEndScope) {
  const tenantScope = eq(cockpitPushSubscriptions.tenant_id, scope.tenant_id);
  if ("session_ids" in scope)
    return and(tenantScope, inArray(cockpitPushSubscriptions.session_id, scope.session_ids));
  if ("installation_id" in scope)
    return and(tenantScope, eq(cockpitPushSubscriptions.installation_id, scope.installation_id));
  if ("user_id" in scope)
    return and(
      tenantScope,
      inArray(
        cockpitPushSubscriptions.installation_id,
        exec
          .select({ id: cockpitInstallations.id })
          .from(cockpitInstallations)
          .where(
            and(
              eq(cockpitInstallations.tenant_id, scope.tenant_id),
              eq(cockpitInstallations.owner_user_id, scope.user_id),
            ),
          ),
      ),
    );
  return tenantScope;
}

function endScopeResource(scope: CockpitPushEndScope): string {
  if ("session_ids" in scope) return scope.session_ids[0] ?? scope.tenant_id;
  if ("installation_id" in scope) return scope.installation_id;
  if ("user_id" in scope) return scope.user_id;
  return scope.tenant_id;
}

export async function endCockpitPushForSessions(
  exec: Executor,
  scope: CockpitPushEndScope,
  reason: CockpitPushEndReason,
  actor: { actor_type: AuditActorType; actor_id: string | null },
): Promise<number> {
  if ("session_ids" in scope && scope.session_ids.length === 0) return 0;
  const removed = await exec
    .delete(cockpitPushSubscriptions)
    .where(endScopeWhere(exec, scope))
    .returning({ installation_id: cockpitPushSubscriptions.installation_id });
  if (removed.length === 0) return 0;
  await auditAwait(
    {
      tenant_id: scope.tenant_id,
      actor_type: actor.actor_type,
      actor_id: actor.actor_id,
      action: AuditAction.COCKPIT_PUSH_SUBSCRIPTION_REMOVED,
      resource_type: "cockpit_push_subscription",
      resource_id: endScopeResource(scope),
      result: "success",
      reason,
      metadata: {
        count: removed.length,
        installation_ids: [...new Set(removed.map((row) => row.installation_id))].sort(),
      },
    },
    exec,
  );
  return removed.length;
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
    .where(activeSessionWhere(context, new Date(now())))
    .limit(1);
  return rows.length > 0;
}

export type CockpitPushOutcome = {
  subscription_id: string;
  installation_id: string;
  endpoint_host: string;
} & (
  | { status: "delivered" }
  | { status: "gone"; status_code: number }
  | { status: "failed"; status_code?: number; error_name: string }
);

export interface CockpitPushSendResult {
  attempted: number;
  delivered: number;
  outcomes: CockpitPushOutcome[];
}

export interface CockpitPushAudienceRow {
  id: string;
  installation_id: string;
  owner_user_id: string;
  notified_attention_keys: string[] | null;
}

function audienceSelection(
  exec: Executor,
  scope: { tenant_id: string; installation_id?: string; subscription_ids?: string[] },
  at: Date,
) {
  return exec
    .select({
      id: cockpitPushSubscriptions.id,
      installation_id: cockpitPushSubscriptions.installation_id,
      owner_user_id: cockpitInstallations.owner_user_id,
      session_id: cockpitPushSubscriptions.session_id,
      endpoint_sha256: cockpitPushSubscriptions.endpoint_sha256,
      ciphertext: cockpitPushSubscriptions.ciphertext,
      iv: cockpitPushSubscriptions.iv,
      auth_tag: cockpitPushSubscriptions.auth_tag,
      notified_attention_keys: cockpitPushSubscriptions.notified_attention_keys,
    })
    .from(cockpitPushSubscriptions)
    .innerJoin(sessions, eq(sessions.id, cockpitPushSubscriptions.session_id))
    .innerJoin(
      cockpitInstallations,
      eq(cockpitInstallations.id, cockpitPushSubscriptions.installation_id),
    )
    .innerJoin(users, eq(users.id, cockpitInstallations.owner_user_id))
    .innerJoin(tenants, eq(tenants.id, cockpitPushSubscriptions.tenant_id))
    .where(
      and(
        ...(scope.installation_id
          ? [eq(cockpitPushSubscriptions.installation_id, scope.installation_id)]
          : []),
        ...(scope.subscription_ids
          ? [inArray(cockpitPushSubscriptions.id, scope.subscription_ids)]
          : []),
        pushAudienceWhere(exec, eq(cockpitPushSubscriptions.tenant_id, scope.tenant_id), at),
      ),
    )
    .orderBy(asc(cockpitPushSubscriptions.installation_id), asc(cockpitPushSubscriptions.id));
}

export async function listCockpitPushAudience(
  exec: Executor,
  tenantId: string,
  at: Date,
): Promise<CockpitPushAudienceRow[]> {
  const rows = await audienceSelection(exec, { tenant_id: tenantId }, at).limit(PUSH_AUDIENCE_MAX);
  return rows.map((row) => ({
    id: row.id,
    installation_id: row.installation_id,
    owner_user_id: row.owner_user_id,
    notified_attention_keys: row.notified_attention_keys,
  }));
}

export async function listCockpitPushTenants(exec: Executor, at: Date): Promise<string[]> {
  // tenant-filter:exempt — the attention pass visits every tenant that still has a live push audience
  const rows = await exec
    .selectDistinct({ tenant_id: cockpitPushSubscriptions.tenant_id })
    .from(cockpitPushSubscriptions)
    .innerJoin(sessions, eq(sessions.id, cockpitPushSubscriptions.session_id))
    .innerJoin(
      cockpitInstallations,
      eq(cockpitInstallations.id, cockpitPushSubscriptions.installation_id),
    )
    .innerJoin(users, eq(users.id, cockpitInstallations.owner_user_id))
    .innerJoin(tenants, eq(tenants.id, cockpitPushSubscriptions.tenant_id))
    .where(pushAudienceWhere(exec, sql`true`, at))
    .orderBy(asc(cockpitPushSubscriptions.tenant_id))
    .limit(PUSH_TENANTS_MAX);
  return rows.map((row) => row.tenant_id);
}

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

export async function sendCockpitPushNotifications(input: {
  db: Db;
  tenant_id: string;
  installation_id?: string;
  subscription_ids?: string[];
  subject: string;
  now?: Date;
  send?: typeof webpush.sendNotification;
}): Promise<CockpitPushSendResult> {
  const subject = new URL(input.subject);
  if (subject.protocol !== "https:" || subject.username || subject.password)
    throw new Error("cockpit push subject must be an HTTPS URL without credentials");
  const at = input.now ?? new Date(now());
  if (input.subscription_ids?.length === 0) return { attempted: 0, delivered: 0, outcomes: [] };
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
  if (!key) return { attempted: 0, delivered: 0, outcomes: [] };
  const vapid = parseKeyPair(decryptSecret(key, keyAad(input.tenant_id)));
  const rows = await audienceSelection(
    input.db,
    {
      tenant_id: input.tenant_id,
      ...(input.installation_id ? { installation_id: input.installation_id } : {}),
      ...(input.subscription_ids ? { subscription_ids: input.subscription_ids } : {}),
    },
    at,
  ).limit(PUSH_AUDIENCE_MAX);
  const outcomes: CockpitPushOutcome[] = [];
  for (const row of rows) {
    const context: CockpitPushContext = {
      installation_id: row.installation_id,
      tenant_id: input.tenant_id,
      user_id: row.owner_user_id,
      session_id: row.session_id,
      expires_at: null,
    };
    const live = await audienceSelection(
      input.db,
      { tenant_id: input.tenant_id, subscription_ids: [row.id] },
      at,
    ).limit(1);
    if (live.length === 0) continue;
    let endpointHost = "unknown";
    try {
      const subscription = parseSubscription(
        decryptSecret(row, subscriptionAad(context, row.endpoint_sha256)),
      );
      const endpoint = parseCockpitPushEndpoint(subscription.endpoint);
      endpointHost = endpoint.hostname;
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
        TTL: PUSH_TTL_SECONDS,
        urgency: "normal",
      });
      outcomes.push({
        subscription_id: row.id,
        installation_id: row.installation_id,
        status: "delivered",
        endpoint_host: endpointHost,
      });
    } catch (error) {
      const statusCode = statusCodeOf(error);
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
              metadata: { installation_id: row.installation_id, reason: "endpoint_gone" },
            },
            input.db,
          );
        outcomes.push({
          subscription_id: row.id,
          installation_id: row.installation_id,
          status: "gone",
          status_code: statusCode,
          endpoint_host: endpointHost,
        });
        continue;
      }
      outcomes.push({
        subscription_id: row.id,
        installation_id: row.installation_id,
        status: "failed",
        ...(statusCode !== undefined ? { status_code: statusCode } : {}),
        error_name: error instanceof Error ? error.name : "unknown",
        endpoint_host: endpointHost,
      });
    }
  }
  return {
    attempted: outcomes.length,
    delivered: outcomes.filter((outcome) => outcome.status === "delivered").length,
    outcomes,
  };
}
