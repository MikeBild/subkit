import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expireBrowserSession, revokeBrowserSession } from "../auth/browser-session.ts";
import { encryptSecret } from "../crypto/index.ts";
import { auditLog } from "../db/schema/audit.ts";
import { cockpitPushKeys, cockpitPushSubscriptions } from "../db/schema/cockpit-push.ts";
import { sessions, tenants, users } from "../db/schema/identity.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { revokeCockpitInstallation } from "./cockpit-installations.ts";
import {
  COCKPIT_PUSH_IDLE_MAX_MS,
  cockpitPushSubscriptionActive,
  endCockpitPushForSessions,
  listCockpitPushAudience,
  listCockpitPushTenants,
  rebindCockpitBrowserPushSubscription,
  removeCockpitPushSubscription,
  sendCockpitPushNotifications,
  upsertCockpitPushSubscription,
} from "./cockpit-push.ts";
import { cockpitPushFixtures, HOUR_MS, recordingSender, SUBJECT } from "./cockpit-push-fixtures.ts";
import { deactivateUser } from "./provisioning.ts";

const NEUTRAL_PAYLOAD = JSON.stringify({ type: "attention" });

let ctx: HttpTestServer;

let at: Date;

const { memberUser, nextUuid, pushFixture, removalAudits } = cockpitPushFixtures({
  get ctx() {
    return ctx;
  },
  get at() {
    return at;
  },
});

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

describe("browser tab push", () => {
  const browserKeys = {
    p256dh: Buffer.from(
      "04" +
        "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" +
        "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
      "hex",
    ).toString("base64url"),
    auth: Buffer.alloc(16, 9).toString("base64url"),
  };
  let browserEndpointSequence = 0;
  const browserEndpoint = () =>
    `https://fcm.googleapis.com/fcm/send/browser-tab-${++browserEndpointSequence}`;

  async function rootSession(
    userId: string,
    input: { tenantId?: string; lastSeenAt?: Date } = {},
  ): Promise<string> {
    const id = nextUuid();
    const lastSeenAt = input.lastSeenAt ?? at;
    await ctx.db.insert(sessions).values({
      id,
      tenant_id: input.tenantId ?? ctx.tenantId,
      user_id: userId,
      expires_at: new Date(at.getTime() + HOUR_MS),
      absolute_expires_at: new Date(at.getTime() + HOUR_MS),
      last_seen_at: lastSeenAt,
      created_at: lastSeenAt,
    });
    return id;
  }

  const browserContext = (userId: string, sessionId: string, tenantId = ctx.tenantId) => ({
    kind: "browser" as const,
    tenant_id: tenantId,
    user_id: userId,
    session_id: sessionId,
    expires_at: null,
  });

  async function browserOptIn(
    input: {
      userId?: string;
      sessionId?: string;
      endpoint?: string;
      device?: string;
      tenantId?: string;
      lastSeenAt?: Date;
    } = {},
  ) {
    const tenantId = input.tenantId ?? ctx.tenantId;
    const userId = input.userId ?? (await memberUser());
    const sessionId =
      input.sessionId ??
      (await rootSession(userId, {
        tenantId,
        ...(input.lastSeenAt ? { lastSeenAt: input.lastSeenAt } : {}),
      }));
    const endpoint = input.endpoint ?? browserEndpoint();
    await upsertCockpitPushSubscription(
      ctx.db,
      browserContext(userId, sessionId, tenantId),
      { endpoint, keys: browserKeys },
      input.device ? { device: input.device } : {},
    );
    const [row] = await ctx.db
      .select()
      .from(cockpitPushSubscriptions)
      .where(
        and(
          eq(cockpitPushSubscriptions.tenant_id, tenantId),
          eq(
            cockpitPushSubscriptions.endpoint_sha256,
            createHash("sha256").update(endpoint).digest("hex"),
          ),
        ),
      );
    if (!row) throw new Error("missing browser push row");
    return { userId, sessionId, endpoint, row };
  }

  async function browserRows(userId: string) {
    return await ctx.db
      .select({
        id: cockpitPushSubscriptions.id,
        session_id: cockpitPushSubscriptions.session_id,
        notified_attention_keys: cockpitPushSubscriptions.notified_attention_keys,
      })
      .from(cockpitPushSubscriptions)
      .where(
        and(
          eq(cockpitPushSubscriptions.tenant_id, ctx.tenantId),
          eq(cockpitPushSubscriptions.user_id, userId),
        ),
      );
  }

  async function sendToRow(id: string, send: unknown, tenantId = ctx.tenantId) {
    return await sendCockpitPushNotifications({
      db: ctx.db,
      tenant_id: tenantId,
      subject: SUBJECT,
      now: at,
      subscription_ids: [id],
      send: send as never,
    });
  }

  async function otherTenant() {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: `push-browser-${nextUuid()}`, display_name: "Browser push" })
      .returning({ id: tenants.id });
    if (!tenant) throw new Error("missing browser push tenant");
    const key = encryptSecret(
      JSON.stringify({ publicKey: "public-key", privateKey: "private-key" }),
      `cockpit-push-key:${tenant.id}`,
    );
    await ctx.db.insert(cockpitPushKeys).values({ tenant_id: tenant.id, ...key });
    const [user] = await ctx.db
      .insert(users)
      .values({
        tenant_id: tenant.id,
        email: `push-browser-${nextUuid()}@test.local`,
        role_id: await builtinRoleId(ctx.db, "member"),
      })
      .returning({ id: users.id });
    if (!user) throw new Error("missing browser push tenant user");
    return { tenantId: tenant.id, userId: user.id };
  }

  test("an opt-in stores a user-bound row without an installation and delivers to it", async () => {
    const device = nextUuid();
    const optIn = await browserOptIn({ device });
    expect(optIn.row).toMatchObject({
      kind: "browser",
      user_id: optIn.userId,
      installation_id: null,
      session_id: optIn.sessionId,
      device_sha256: createHash("sha256")
        .update(`${ctx.tenantId}:${optIn.userId}:${device}`)
        .digest("hex"),
    });
    const [audit] = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "cockpit_push.subscription_upserted"),
          eq(auditLog.resource_id, optIn.sessionId),
        ),
      );
    expect(audit?.metadata).toMatchObject({ kind: "browser", superseded: 0 });
    expect(
      await cockpitPushSubscriptionActive(ctx.db, browserContext(optIn.userId, optIn.sessionId)),
    ).toBeTrue();
    const { sent, send } = recordingSender();
    const result = await sendToRow(optIn.row.id, send);
    expect(result.outcomes).toEqual([
      {
        subscription_id: optIn.row.id,
        kind: "browser",
        installation_id: null,
        status: "delivered",
        endpoint_host: "fcm.googleapis.com",
      },
    ]);
    expect(sent).toEqual([
      { endpoint: optIn.endpoint, payload: NEUTRAL_PAYLOAD, subject: SUBJECT },
    ]);
  });

  test("outlives the session expiry and ends after 30 idle days", async () => {
    const userId = await memberUser();
    const sessionId = await rootSession(userId, {
      lastSeenAt: new Date(at.getTime() - 48 * HOUR_MS),
    });
    const optIn = await browserOptIn({ userId, sessionId });
    await ctx.db
      .update(sessions)
      .set({
        expires_at: new Date(at.getTime() - 9 * HOUR_MS),
        absolute_expires_at: new Date(at.getTime() - 9 * HOUR_MS),
      })
      .where(and(eq(sessions.tenant_id, ctx.tenantId), eq(sessions.id, sessionId)));
    await expireBrowserSession(
      ctx.db,
      { id: sessionId, tenant_id: ctx.tenantId, user_id: userId },
      "expired_sliding",
      { actorId: userId, metadata: { via: "browser_session_resolve" } },
    );
    expect((await sendToRow(optIn.row.id, recordingSender().send)).delivered).toBe(1);
    expect(
      await cockpitPushSubscriptionActive(ctx.db, browserContext(userId, sessionId)),
    ).toBeFalse();

    const idle = await browserOptIn({
      lastSeenAt: new Date(at.getTime() - COCKPIT_PUSH_IDLE_MAX_MS - HOUR_MS),
    });
    expect((await sendToRow(idle.row.id, recordingSender().send)).attempted).toBe(0);
  });

  test("an inactive or deleted user and an inactive tenant are not woken", async () => {
    const disabled = await browserOptIn();
    await ctx.db
      .update(users)
      .set({ status: "disabled" })
      .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, disabled.userId)));
    const deleted = await browserOptIn();
    await ctx.db
      .update(users)
      .set({ deleted_at: at })
      .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, deleted.userId)));
    const suspended = await otherTenant();
    const foreign = await browserOptIn({
      tenantId: suspended.tenantId,
      userId: suspended.userId,
    });
    await ctx.db
      .update(tenants)
      .set({ status: "suspended" })
      .where(eq(tenants.id, suspended.tenantId));
    const { sent, send } = recordingSender();
    expect((await sendToRow(disabled.row.id, send)).attempted).toBe(0);
    expect((await sendToRow(deleted.row.id, send)).attempted).toBe(0);
    expect((await sendToRow(foreign.row.id, send, suspended.tenantId)).attempted).toBe(0);
    expect(sent).toEqual([]);
  });

  test("logout, session replacement, deactivation and tenant lifecycle end browser rows", async () => {
    const loggedOut = await browserOptIn();
    await revokeBrowserSession(
      ctx.db,
      { session_id: loggedOut.sessionId, user_id: loggedOut.userId, tenant_id: ctx.tenantId },
      "user_logout",
    );
    expect(await browserRows(loggedOut.userId)).toEqual([]);

    const replaced = await browserOptIn();
    expect(
      await endCockpitPushForSessions(
        ctx.db,
        { tenant_id: ctx.tenantId, session_ids: [replaced.sessionId] },
        "session_replaced",
        { actor_type: "user", actor_id: replaced.userId },
      ),
    ).toBe(1);
    expect(await browserRows(replaced.userId)).toEqual([]);

    const deactivated = await browserOptIn();
    await deactivateUser(
      {
        tenant_id: ctx.tenantId,
        user_id: deactivated.userId,
        actor_id: ctx.userId,
        actor_kind: "user",
      },
      ctx.db,
    );
    expect(await browserRows(deactivated.userId)).toEqual([]);
    const deactivation = (await removalAudits("user_deactivated")).find((audit) =>
      (audit.metadata as { kinds?: string[] }).kinds?.includes("browser"),
    );
    expect(deactivation?.metadata).toMatchObject({ count: 1, kinds: ["browser"] });

    const lifecycle = await otherTenant();
    const lifecycleRow = await browserOptIn({
      tenantId: lifecycle.tenantId,
      userId: lifecycle.userId,
    });
    expect(
      await endCockpitPushForSessions(
        ctx.db,
        { tenant_id: lifecycle.tenantId, tenant: true },
        "tenant_lifecycle",
        { actor_type: "user", actor_id: lifecycle.userId },
      ),
    ).toBe(1);
    const [left] = await ctx.db
      .select({ id: cockpitPushSubscriptions.id })
      .from(cockpitPushSubscriptions)
      .where(
        and(
          eq(cockpitPushSubscriptions.tenant_id, lifecycle.tenantId),
          eq(cockpitPushSubscriptions.id, lifecycleRow.row.id),
        ),
      );
    expect(left).toBeUndefined();
  });

  test("an installation revoke leaves the owner's browser rows alone", async () => {
    const installed = await pushFixture();
    const optIn = await browserOptIn({ userId: installed.userId });
    expect(
      await revokeCockpitInstallation(
        ctx.db,
        installed.installationId,
        ctx.tenantId,
        installed.userId,
      ),
    ).toBeTrue();
    expect((await browserRows(installed.userId)).map((row) => row.id)).toEqual([optIn.row.id]);
  });

  test("an explicit removal ends the current session's browser row", async () => {
    const optIn = await browserOptIn();
    expect(
      await removeCockpitPushSubscription(ctx.db, browserContext(optIn.userId, optIn.sessionId)),
    ).toBeTrue();
    expect(await browserRows(optIn.userId)).toEqual([]);
  });

  test("a re-bind moves the row to the renewed session and keeps its notified keys", async () => {
    const optIn = await browserOptIn();
    const notified = ["a".repeat(64)];
    await ctx.db
      .update(cockpitPushSubscriptions)
      .set({ notified_attention_keys: notified })
      .where(
        and(
          eq(cockpitPushSubscriptions.tenant_id, ctx.tenantId),
          eq(cockpitPushSubscriptions.id, optIn.row.id),
        ),
      );
    const renewed = await rootSession(optIn.userId);
    expect(
      await rebindCockpitBrowserPushSubscription(
        ctx.db,
        browserContext(optIn.userId, renewed),
        { endpoint: optIn.endpoint, keys: browserKeys },
        { device: nextUuid() },
      ),
    ).toBeTrue();
    expect(await browserRows(optIn.userId)).toEqual([
      { id: optIn.row.id, session_id: renewed, notified_attention_keys: notified },
    ]);
    expect((await sendToRow(optIn.row.id, recordingSender().send)).delivered).toBe(1);
  });

  test("a re-bind never moves another user's or another tenant's row", async () => {
    const optIn = await browserOptIn();
    const intruder = await memberUser();
    expect(
      await rebindCockpitBrowserPushSubscription(
        ctx.db,
        browserContext(intruder, await rootSession(intruder)),
        { endpoint: optIn.endpoint, keys: browserKeys },
        {},
      ),
    ).toBeFalse();
    const foreign = await otherTenant();
    expect(
      await rebindCockpitBrowserPushSubscription(
        ctx.db,
        browserContext(
          foreign.userId,
          await rootSession(foreign.userId, { tenantId: foreign.tenantId }),
          foreign.tenantId,
        ),
        { endpoint: optIn.endpoint, keys: browserKeys },
        {},
      ),
    ).toBeFalse();
    expect((await browserRows(optIn.userId)).map((row) => row.session_id)).toEqual([
      optIn.sessionId,
    ]);
  });

  test("another user's opt-in on the same browser supersedes without carrying keys", async () => {
    const first = await browserOptIn();
    await ctx.db
      .update(cockpitPushSubscriptions)
      .set({ notified_attention_keys: ["b".repeat(64)] })
      .where(
        and(
          eq(cockpitPushSubscriptions.tenant_id, ctx.tenantId),
          eq(cockpitPushSubscriptions.id, first.row.id),
        ),
      );
    const second = await browserOptIn({ endpoint: first.endpoint });
    expect(await browserRows(first.userId)).toEqual([]);
    const [row] = await browserRows(second.userId);
    expect(row?.notified_attention_keys).toBeNull();
  });

  test("a user keeps at most ten browser rows", async () => {
    const userId = await memberUser();
    const created: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const optIn = await browserOptIn({ userId });
      await ctx.db
        .update(cockpitPushSubscriptions)
        .set({ updated_at: new Date(at.getTime() - (11 - index) * 60_000) })
        .where(
          and(
            eq(cockpitPushSubscriptions.tenant_id, ctx.tenantId),
            eq(cockpitPushSubscriptions.id, optIn.row.id),
          ),
        );
      created.push(optIn.row.id);
    }
    const remaining = (await browserRows(userId)).map((row) => row.id);
    expect(remaining).toHaveLength(10);
    expect(remaining).not.toContain(created[0] ?? "");
  });

  test("tenants with only browser rows are visited and never leak across tenants", async () => {
    const foreign = await otherTenant();
    const foreignRow = await browserOptIn({ tenantId: foreign.tenantId, userId: foreign.userId });
    const tenantIds = await listCockpitPushTenants(ctx.db, at);
    expect(tenantIds).toContain(foreign.tenantId);
    const [firstTenant, ...laterTenants] = tenantIds;
    expect(await listCockpitPushTenants(ctx.db, at, { limit: 1 })).toEqual([firstTenant ?? ""]);
    expect(await listCockpitPushTenants(ctx.db, at, { after: firstTenant ?? null })).toEqual(
      laterTenants,
    );
    const audience = await listCockpitPushAudience(ctx.db, ctx.tenantId, at);
    expect(audience.map((row) => row.id)).not.toContain(foreignRow.row.id);
    expect(await listCockpitPushAudience(ctx.db, foreign.tenantId, at)).toEqual([
      {
        id: foreignRow.row.id,
        kind: "browser",
        installation_id: null,
        user_id: foreign.userId,
        device_sha256: null,
        notified_attention_keys: null,
        notified_at: null,
      },
    ]);
  });
});
