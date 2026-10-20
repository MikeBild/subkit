import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { encryptSecret } from "../crypto/aes-gcm.ts";
import { cockpitInstallations } from "../db/schema/cockpit-installations.ts";
import { cockpitPushKeys, cockpitPushSubscriptions } from "../db/schema/cockpit-push.ts";
import { sessions } from "../db/schema/identity.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { parseCockpitPushEndpoint, sendCockpitPushNotifications } from "./cockpit-push.ts";

let ctx: HttpTestServer;
let installationId: string;
let sessionId: string;
const nextUuid = createDeterministicUuidFactory(0xc0c1);

beforeAll(async () => {
  ctx = await createHttpTestServer("cockpit-push");
  installationId = nextUuid();
  sessionId = nextUuid();
  await ctx.db.insert(cockpitInstallations).values({
    id: installationId,
    tenant_id: ctx.tenantId,
    owner_user_id: ctx.userId,
  });
  await ctx.db.insert(sessions).values({
    id: sessionId,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    installation_id: installationId,
    expires_at: new Date(getTestNow() + 60 * 60_000),
    absolute_expires_at: new Date(getTestNow() + 60 * 60_000),
  });
  const key = encryptSecret(
    JSON.stringify({ publicKey: "public-key", privateKey: "private-key" }),
    `cockpit-push-key:${ctx.tenantId}`,
  );
  await ctx.db.insert(cockpitPushKeys).values({ tenant_id: ctx.tenantId, ...key });
  const endpoint = "https://fcm.googleapis.com/fcm/send/test";
  const hash = createHash("sha256").update(endpoint).digest("hex");
  const subscription = encryptSecret(
    JSON.stringify({
      endpoint,
      keys: {
        p256dh: "a".repeat(64),
        auth: "b".repeat(16),
      },
    }),
    `cockpit-push-subscription:${ctx.tenantId}:${installationId}:${sessionId}:${hash}`,
  );
  await ctx.db.insert(cockpitPushSubscriptions).values({
    tenant_id: ctx.tenantId,
    installation_id: installationId,
    session_id: sessionId,
    endpoint_sha256: hash,
    ...subscription,
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

test("sends only a neutral payload through an injected sender", async () => {
  const sent: Array<{ payload: string; subject: string | undefined }> = [];
  const result = await sendCockpitPushNotifications({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    installation_id: installationId,
    subject: "https://subkit.example",
    send: async (_subscription, payload, options) => {
      sent.push({ payload: String(payload), subject: options?.vapidDetails?.subject });
      return {} as never;
    },
  });
  expect(result).toEqual({ attempted: 1, delivered: 1 });
  expect(sent).toEqual([
    {
      payload: JSON.stringify({
        title: "SubKit",
        body: "Attention required",
        tag: "subkit-attention",
        data: {},
      }),
      subject: "https://subkit.example",
    },
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

test("does not send after the bound session is revoked", async () => {
  await ctx.db
    .update(sessions)
    .set({ revoked_at: new Date(getTestNow()) })
    .where(eq(sessions.id, sessionId));
  const result = await sendCockpitPushNotifications({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    installation_id: installationId,
    subject: "https://subkit.example",
    send: async () => {
      throw new Error("sender must not be called");
    },
  });
  expect(result).toEqual({ attempted: 0, delivered: 0 });
});
