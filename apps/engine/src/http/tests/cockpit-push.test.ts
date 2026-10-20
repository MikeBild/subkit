import { afterAll, beforeAll, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

let server: HttpTestServer;
beforeAll(async () => {
  server = await createHttpTestServer("cockpit-push-http");
});
afterAll(async () => {
  if (server) await server.cleanup();
});

test("push opt-in is scoped to the current app session and retains CSRF and key validation", async () => {
  const root = await browserSessionHeaders(server, server.userId);
  const created = await fetch(`${server.baseUrl}/v1/cockpit/installations`, {
    method: "POST",
    headers: root,
    body: "{}",
  });
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };
  const base = `${server.baseUrl}/cockpit/i/${id}/api/v1`;
  const cookie = created.headers.get("set-cookie") ?? "";
  const boot = await fetch(`${base}/cockpit/bootstrap`, { headers: { cookie } });
  expect(boot.status).toBe(200);
  const { csrf_token } = (await boot.json()) as { csrf_token: string };
  const headers = { cookie, "x-subkit-csrf": csrf_token, "content-type": "application/json" };
  const denied = await fetch(`${base}/cockpit/push-subscription/prepare`, {
    method: "POST",
    headers: { cookie },
    body: "{}",
  });
  expect(denied.status).toBe(403);
  const rootDenied = await fetch(`${server.baseUrl}/v1/cockpit/push-subscription/prepare`, {
    method: "POST",
    headers: root,
    body: "{}",
  });
  expect(rootDenied.status).toBe(401);
  const prepared = await fetch(`${base}/cockpit/push-subscription/prepare`, {
    method: "POST",
    headers,
    body: "{}",
  });
  expect(prepared.status).toBe(200);
  expect(((await prepared.json()) as { public_key: string }).public_key).toMatch(
    /^[A-Za-z0-9_-]{87}$/,
  );
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from("1".padStart(64, "0"), "hex"));
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/isolated-fixture",
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 7).toString("base64url"),
    },
  };
  const invalid = await fetch(`${base}/cockpit/push-subscription`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      ...subscription,
      keys: { ...subscription.keys, p256dh: "a".repeat(64) },
    }),
  });
  expect(invalid.status).toBe(400);
  const stored = await fetch(`${base}/cockpit/push-subscription`, {
    method: "PUT",
    headers,
    body: JSON.stringify(subscription),
  });
  expect(stored.status).toBe(204);
  const active = await fetch(`${base}/cockpit/push-subscription`, { headers });
  expect(await active.json()).toEqual({ subscribed: true });
  const removed = await fetch(`${base}/cockpit/push-subscription`, { method: "DELETE", headers });
  expect(removed.status).toBe(204);
  const inactive = await fetch(`${base}/cockpit/push-subscription`, { headers });
  expect(await inactive.json()).toEqual({ subscribed: false });
});
