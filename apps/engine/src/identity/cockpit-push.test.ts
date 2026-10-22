import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { expireBrowserSession, revokeBrowserSession } from "../auth/browser-session.ts";
import { encryptSecret } from "../crypto/aes-gcm.ts";
import { auditLog } from "../db/schema/audit.ts";
import { cockpitInstallations } from "../db/schema/cockpit-installations.ts";
import { cockpitPushKeys, cockpitPushSubscriptions } from "../db/schema/cockpit-push.ts";
import { sessions, users } from "../db/schema/identity.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { revokeCockpitInstallation } from "./cockpit-installations.ts";
import {
  COCKPIT_PUSH_IDLE_MAX_MS,
  endCockpitPushForSessions,
  parseCockpitPushEndpoint,
  sendCockpitPushNotifications,
  upsertCockpitPushSubscription,
} from "./cockpit-push.ts";
import { deactivateUser } from "./provisioning.ts";

const HOUR_MS = 60 * 60_000;
const SUBJECT = "https://subkit.example";
const NEUTRAL_PAYLOAD = JSON.stringify({
  title: "SubKit",
  body: "Attention required",
  tag: "subkit-attention",
  data: {},
});

let ctx: HttpTestServer;
let at: Date;
const nextUuid = createDeterministicUuidFactory(0xc0c1);
let endpointSequence = 0;

interface PushFixture {
  installationId: string;
  sessionId: string;
  userId: string;
  subscriptionId: string;
  endpoint: string;
}

async function memberUser(): Promise<string> {
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: `push-member-${nextUuid()}@test.local`,
      role_id: await builtinRoleId(ctx.db, "member"),
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
  await ctx.db.insert(sessions).values({
    id,
    tenant_id: ctx.tenantId,
    user_id: input.userId,
    installation_id: input.installationId,
    expires_at: new Date(at.getTime() + (input.expired ? -HOUR_MS : HOUR_MS)),
    absolute_expires_at: new Date(at.getTime() + (input.expired ? -HOUR_MS : HOUR_MS)),
    last_seen_at: input.lastSeenAt === undefined ? at : input.lastSeenAt,
    created_at: input.lastSeenAt ?? at,
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
    `cockpit-push-subscription:${ctx.tenantId}:${input.installationId}:${input.sessionId}:${hash}`,
  );
  const [row] = await ctx.db
    .insert(cockpitPushSubscriptions)
    .values({
      tenant_id: ctx.tenantId,
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
  await ctx.db.insert(cockpitInstallations).values({
    id: installationId,
    tenant_id: ctx.tenantId,
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

function recordingSender() {
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

async function sendTo(fixture: Pick<PushFixture, "installationId">, send: unknown) {
  return await sendCockpitPushNotifications({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    installation_id: fixture.installationId,
    subject: SUBJECT,
    now: at,
    send: send as never,
  });
}

async function subscriptionRows(installationId: string) {
  return await ctx.db
    .select({
      id: cockpitPushSubscriptions.id,
      session_id: cockpitPushSubscriptions.session_id,
    })
    .from(cockpitPushSubscriptions)
    .where(
      and(
        eq(cockpitPushSubscriptions.tenant_id, ctx.tenantId),
        eq(cockpitPushSubscriptions.installation_id, installationId),
      ),
    );
}

async function removalAudits(reason: string) {
  return await ctx.db
    .select({ reason: auditLog.reason, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, "cockpit_push.subscription_removed"),
        eq(auditLog.reason, reason),
      ),
    );
}

beforeAll(async () => {
  ctx = await createHttpTestServer("cockpit-push");
  at = new Date(getTestNow());
  const key = encryptSecret(
    JSON.stringify({ publicKey: "public-key", privateKey: "private-key" }),
    `cockpit-push-key:${ctx.tenantId}`,
  );
  await ctx.db.insert(cockpitPushKeys).values({ tenant_id: ctx.tenantId, ...key });
});

afterAll(async () => {
  await ctx.cleanup();
});

test("sends only a neutral payload through an injected sender", async () => {
  const fixture = await pushFixture();
  const { sent, send } = recordingSender();
  const result = await sendTo(fixture, send);
  expect(result.attempted).toBe(1);
  expect(result.delivered).toBe(1);
  expect(result.outcomes).toEqual([
    {
      subscription_id: fixture.subscriptionId,
      installation_id: fixture.installationId,
      status: "delivered",
      endpoint_host: "fcm.googleapis.com",
    },
  ]);
  expect(sent).toEqual([
    { endpoint: fixture.endpoint, payload: NEUTRAL_PAYLOAD, subject: SUBJECT },
  ]);
});

test("accepts documented browser push host boundaries and rejects unsafe endpoints", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/subscription",
    "https://updates.push.services.mozilla.com/wpush/v2/subscription",
    "https://web.push.apple.com/QH/subscription",
    "https://p123.push.apple.com/QH/subscription",
    "https://wns2-sg2p.notify.windows.com/w/?token=value",
  ]) {
    expect(parseCockpitPushEndpoint(endpoint).hostname).toBe(new URL(endpoint).hostname);
  }
  for (const endpoint of [
    "https://notpush.apple.com/subscription",
    "https://push.apple.com/subscription",
    "https://fcm.googleapis.com.attacker.test/subscription",
    "https://user@fcm.googleapis.com/subscription",
    "https://fcm.googleapis.com:8443/subscription",
    "https://fcm.googleapis.com/subscription#fragment",
    "https://127.0.0.1/subscription",
  ]) {
    expect(() => parseCockpitPushEndpoint(endpoint)).toThrow("not permitted");
  }
});

test("delivers after the opt-in session expired idle", async () => {
  const fixture = await pushFixture({ expired: true });
  await expireBrowserSession(
    ctx.db,
    { id: fixture.sessionId, tenant_id: ctx.tenantId, user_id: fixture.userId },
    "expired_sliding",
    { actorId: fixture.userId, metadata: { via: "browser_session_resolve" } },
  );
  const { sent, send } = recordingSender();
  const result = await sendTo(fixture, send);
  expect(result.delivered).toBe(1);
  expect(sent.map((entry) => entry.endpoint)).toEqual([fixture.endpoint]);
});

test("no push after 30 days without app use", async () => {
  const fixture = await pushFixture({
    lastSeenAt: new Date(at.getTime() - COCKPIT_PUSH_IDLE_MAX_MS - HOUR_MS),
  });
  const { sent, send } = recordingSender();
  const result = await sendTo(fixture, send);
  expect(result.attempted).toBe(0);
  expect(sent).toEqual([]);
});

describe("explicit revocations end push", () => {
  const neverSend = async () => {
    throw new Error("sender must not be called");
  };

  test("browser logout", async () => {
    const fixture = await pushFixture();
    await revokeBrowserSession(
      ctx.db,
      { session_id: fixture.sessionId, user_id: fixture.userId, tenant_id: ctx.tenantId },
      "user_logout",
    );
    expect(await subscriptionRows(fixture.installationId)).toEqual([]);
    expect((await sendTo(fixture, neverSend)).attempted).toBe(0);
    const audits = await removalAudits("session_logout");
    expect(audits.length).toBeGreaterThan(0);
  });

  test("user deactivation", async () => {
    const userId = await memberUser();
    const fixture = await pushFixture({ userId });
    await deactivateUser(
      { tenant_id: ctx.tenantId, user_id: userId, actor_id: ctx.userId, actor_kind: "user" },
      ctx.db,
    );
    expect(await subscriptionRows(fixture.installationId)).toEqual([]);
    expect((await sendTo(fixture, neverSend)).attempted).toBe(0);
    expect((await removalAudits("user_deactivated")).length).toBe(1);
  });

  test("installation revoke", async () => {
    const fixture = await pushFixture();
    expect(
      await revokeCockpitInstallation(ctx.db, fixture.installationId, ctx.tenantId, fixture.userId),
    ).toBeTrue();
    expect(await subscriptionRows(fixture.installationId)).toEqual([]);
    expect((await removalAudits("installation_revoked")).length).toBe(1);
  });

  test("membership switch scope removes only the replaced session", async () => {
    const fixture = await pushFixture();
    const other = await pushFixture();
    const removed = await endCockpitPushForSessions(
      ctx.db,
      { tenant_id: ctx.tenantId, session_ids: [fixture.sessionId] },
      "session_replaced",
      { actor_type: "user", actor_id: fixture.userId },
    );
    expect(removed).toBe(1);
    expect(await subscriptionRows(fixture.installationId)).toEqual([]);
    expect(await subscriptionRows(other.installationId)).toHaveLength(1);
    const [audit] = await removalAudits("session_replaced");
    expect(audit?.metadata).toMatchObject({ count: 1 });
  });
});

test("every explicit session revocation also ends push", () => {
  const root = join(import.meta.dir, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) files.push(path);
    }
  };
  walk(root);
  const writer =
    /\.update\((?:schema\.)?sessions\)\s*\.set\(\{[^}]*revoked_at|UPDATE\s+(?:subkit\.)?sessions\s+SET[^;]*revoked_at/gi;
  const missing: string[] = [];
  let writers = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(writer)) {
      writers += 1;
      const start = source.lastIndexOf("\n}\n", match.index);
      const endIndex = source.indexOf("\n}\n", match.index);
      const block = source.slice(start < 0 ? 0 : start, endIndex < 0 ? source.length : endIndex);
      if (block.includes("export async function expireBrowserSession(")) continue;
      if (!block.includes("endCockpitPushForSessions(")) missing.push(file.slice(root.length));
    }
  }
  expect(writers).toBeGreaterThan(5);
  expect(missing).toEqual([]);
});

describe("renewed sessions and devices", () => {
  const ecdhPublicKey = Buffer.from(
    "04" +
      "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" +
      "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
    "hex",
  ).toString("base64url");
  const keys = { p256dh: ecdhPublicKey, auth: Buffer.alloc(16, 7).toString("base64url") };
  const context = (fixture: Pick<PushFixture, "installationId" | "userId">, sessionId: string) => ({
    installation_id: fixture.installationId,
    tenant_id: ctx.tenantId,
    user_id: fixture.userId,
    session_id: sessionId,
    expires_at: null,
  });

  test("renewed session supersedes the same endpoint", async () => {
    const fixture = await pushFixture();
    const renewed = await addSession({
      installationId: fixture.installationId,
      userId: fixture.userId,
    });
    await upsertCockpitPushSubscription(ctx.db, context(fixture, renewed), {
      endpoint: fixture.endpoint,
      keys,
    });
    const rows = await subscriptionRows(fixture.installationId);
    expect(rows.map((row) => row.session_id)).toEqual([renewed]);
    const [audit] = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "cockpit_push.subscription_upserted"),
          eq(auditLog.resource_id, renewed),
        ),
      );
    expect(audit?.metadata).toMatchObject({ superseded: 1 });
  });

  test("two devices keep two rows and each receives", async () => {
    const fixture = await pushFixture();
    const second = await addSession({
      installationId: fixture.installationId,
      userId: fixture.userId,
    });
    await upsertCockpitPushSubscription(ctx.db, context(fixture, second), {
      endpoint: "https://fcm.googleapis.com/fcm/send/second-device",
      keys,
    });
    expect(await subscriptionRows(fixture.installationId)).toHaveLength(2);
    const { sent, send } = recordingSender();
    const result = await sendTo(fixture, send);
    expect(result.delivered).toBe(2);
    expect(sent.map((entry) => entry.endpoint).sort()).toEqual(
      [fixture.endpoint, "https://fcm.googleapis.com/fcm/send/second-device"].sort(),
    );
  });

  test("supersede never crosses installations", async () => {
    const first = await pushFixture();
    const second = await pushFixture();
    await upsertCockpitPushSubscription(ctx.db, context(second, second.sessionId), {
      endpoint: first.endpoint,
      keys,
    });
    expect(await subscriptionRows(first.installationId)).toHaveLength(1);
    expect(await subscriptionRows(second.installationId)).toHaveLength(1);
  });
});

test("live installations are not crowded out by stale subscriptions", async () => {
  const dead = await Promise.all(
    Array.from({ length: 21 }, async () => {
      const userId = await memberUser();
      const fixture = await pushFixture({ userId });
      await ctx.db
        .update(users)
        .set({ status: "disabled" })
        .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, userId)));
      return fixture;
    }),
  );
  const live = await pushFixture();
  const { sent, send } = recordingSender();
  const result = await sendCockpitPushNotifications({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    subject: SUBJECT,
    now: at,
    subscription_ids: [...dead.map((fixture) => fixture.subscriptionId), live.subscriptionId],
    send: send as never,
  });
  expect(result.delivered).toBe(1);
  expect(sent.map((entry) => entry.endpoint)).toEqual([live.endpoint]);
});

test("reports endpoint failures and removes only gone subscriptions", async () => {
  const rejected = await pushFixture();
  const gone = await pushFixture();
  const send = async (subscription: { endpoint: string }) => {
    throw Object.assign(new Error("push service rejected"), {
      statusCode: subscription.endpoint === rejected.endpoint ? 403 : 410,
    });
  };
  const result = await sendCockpitPushNotifications({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    subject: SUBJECT,
    now: at,
    subscription_ids: [rejected.subscriptionId, gone.subscriptionId],
    send: send as never,
  });
  expect(result.delivered).toBe(0);
  expect(result.outcomes).toContainEqual({
    subscription_id: rejected.subscriptionId,
    installation_id: rejected.installationId,
    status: "failed",
    status_code: 403,
    error_name: "Error",
    endpoint_host: "fcm.googleapis.com",
  });
  expect(result.outcomes).toContainEqual({
    subscription_id: gone.subscriptionId,
    installation_id: gone.installationId,
    status: "gone",
    status_code: 410,
    endpoint_host: "fcm.googleapis.com",
  });
  const remaining = await ctx.db
    .select({ id: cockpitPushSubscriptions.id })
    .from(cockpitPushSubscriptions)
    .where(
      and(
        eq(cockpitPushSubscriptions.tenant_id, ctx.tenantId),
        inArray(cockpitPushSubscriptions.id, [rejected.subscriptionId, gone.subscriptionId]),
      ),
    );
  expect(remaining.map((row) => row.id)).toEqual([rejected.subscriptionId]);
});
