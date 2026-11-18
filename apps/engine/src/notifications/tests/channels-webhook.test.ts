import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setConfigKey } from "../../config/loader.ts";
import { _withEgressLookupForTests } from "../../connectors/egress-guard.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../../identity/index.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../test-helpers/workspace-registration.ts";
import { WEBHOOK_MAX_ATTEMPTS, WebhookNotificationAdapter } from "../channels/webhook.ts";

let tdb: TestDb;
let selfhostId: string;
let hostedId: string;
beforeAll(async () => {
  tdb = await createTestDb("notification-webhook-egress");
  await configureHostedPolicyForTests(tdb.db, tdb.url);
  await setConfigKey("egress.mode", "permissive");
  const tenant = await seedTenant(tdb.db, {
    slug: "notification-selfhost",
    display_name: "Selfhost",
  });
  selfhostId = tenant.id;
  hostedId = (
    await provisionSelfServiceTenant(
      {
        issuer_url: "https://identity.example.test",
        subject: "notification-owner",
        email: "owner@example.test",
        email_verified: true,
      },
      TEST_WORKSPACE_REGISTRATION,
      tdb.db,
    )
  ).tenant.id;
}, 30_000);
afterAll(async () => {
  if (tdb) await tdb.cleanup();
});

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function makeFetchSequence(
  responses: Array<Response | (() => Response | Promise<Response>) | Error>,
): {
  calls: FetchCall[];
  sleeps: number[];
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
} {
  const calls: FetchCall[] = [];
  const sleeps: number[] = [];
  let cursor = 0;
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of new Headers(init.headers)) {
        headers[k] = v;
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    const next = responses[cursor++];
    if (next === undefined) throw new Error("fetch sequence exhausted");
    if (next instanceof Error) throw next;
    return Promise.resolve(typeof next === "function" ? next() : next);
  }) as unknown as typeof fetch;
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
  return { calls, sleeps, fetchImpl, sleep };
}

describe("WebhookNotificationAdapter", () => {
  const delivery = {
    get tenant_id() {
      return selfhostId;
    },
    workspace_id: "wsp-1",
    channel_id: "ch-1",
    kind: "message" as const,
    text: "hello",
  };

  test("first-try success returns the message id", async () => {
    const { calls, fetchImpl, sleep } = makeFetchSequence([
      new Response("ok", { status: 200, headers: { "x-message-id": "abc" } }),
    ]);
    const adapter = new WebhookNotificationAdapter({
      exec: tdb.db,
      url: "http://hook.example/post",
      fetchImpl,
      sleepMs: sleep,
    });
    const result = await adapter.send(delivery);
    expect(result.platform_message_id).toBe("abc");
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.headers["x-subkit-attempt"]).toBe("1");
  });

  test("transient 5xx retries and eventually succeeds", async () => {
    const { calls, sleeps, fetchImpl, sleep } = makeFetchSequence([
      new Response("oops", { status: 503 }),
      new Response("ok", { status: 200 }),
    ]);
    const adapter = new WebhookNotificationAdapter({
      exec: tdb.db,
      url: "http://hook.example/post",
      fetchImpl,
      sleepMs: sleep,
    });
    await adapter.send(delivery);
    expect(calls.length).toBe(2);
    expect(sleeps.length).toBe(1);
  });

  test("429 with Retry-After uses the header value for backoff", async () => {
    const { sleeps, fetchImpl, sleep } = makeFetchSequence([
      new Response("limited", { status: 429, headers: { "retry-after": "2" } }),
      new Response("ok", { status: 200 }),
    ]);
    const adapter = new WebhookNotificationAdapter({
      exec: tdb.db,
      url: "http://hook.example/post",
      fetchImpl,
      sleepMs: sleep,
    });
    await adapter.send(delivery);
    expect(sleeps[0]).toBe(2_000);
  });

  test("permanent 4xx aborts after the first attempt", async () => {
    const { calls, fetchImpl, sleep } = makeFetchSequence([new Response("bad", { status: 400 })]);
    const adapter = new WebhookNotificationAdapter({
      exec: tdb.db,
      url: "http://hook.example/post",
      fetchImpl,
      sleepMs: sleep,
    });
    await expect(adapter.send(delivery)).rejects.toThrow();
    expect(calls.length).toBe(1);
  });

  test("network failure falls through the retry budget", async () => {
    const { calls, fetchImpl, sleep } = makeFetchSequence(
      Array.from({ length: WEBHOOK_MAX_ATTEMPTS }, () => new Error("ECONNRESET")),
    );
    const adapter = new WebhookNotificationAdapter({
      exec: tdb.db,
      url: "http://hook.example/post",
      fetchImpl,
      sleepMs: sleep,
    });
    await expect(adapter.send(delivery)).rejects.toThrow();
    expect(calls.length).toBe(WEBHOOK_MAX_ATTEMPTS);
  });

  test("secret is forwarded as x-subkit-secret when configured", async () => {
    const { calls, fetchImpl, sleep } = makeFetchSequence([new Response("ok", { status: 200 })]);
    const adapter = new WebhookNotificationAdapter({
      exec: tdb.db,
      url: "http://hook.example/post",
      secret: "shh",
      fetchImpl,
      sleepMs: sleep,
    });
    await adapter.send(delivery);
    expect(calls[0]?.headers["x-subkit-secret"]).toBe("shh");
  });

  test("persisted hosted origin blocks private DNS answers despite permissive global policy", async () => {
    const { calls, sleeps, fetchImpl, sleep } = makeFetchSequence([new Response("ok")]);
    const adapter = new WebhookNotificationAdapter({
      exec: tdb.db,
      url: "https://hook.example/post",
      secret: "sensitive-notification-token",
      fetchImpl,
      sleepMs: sleep,
    });
    await _withEgressLookupForTests(
      async () => [{ address: "169.254.169.254", family: 4 }],
      async () => {
        await expect(adapter.send({ ...delivery, tenant_id: hostedId })).rejects.toThrow(
          "egress_blocked",
        );
      },
    );
    expect(calls).toHaveLength(0);
    expect(sleeps).toHaveLength(0);
  });

  test("hosted delivery pins the public hop and refuses redirects without replaying its secret", async () => {
    const { calls, sleeps, fetchImpl, sleep } = makeFetchSequence([
      new Response(null, { status: 307, headers: { location: "http://169.254.169.254/" } }),
      new Response("unexpected"),
    ]);
    const adapter = new WebhookNotificationAdapter({
      exec: tdb.db,
      url: "https://hook.example/post",
      secret: "sensitive-notification-token",
      fetchImpl,
      sleepMs: sleep,
    });
    await _withEgressLookupForTests(
      async () => [{ address: "93.184.216.34", family: 4 }],
      async () => {
        await expect(adapter.send({ ...delivery, tenant_id: hostedId })).rejects.toThrow(
          "redirect_blocked",
        );
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://93.184.216.34/post");
    expect(calls[0]?.headers.host).toBe("hook.example");
    expect(calls[0]?.headers["x-subkit-secret"]).toBe("sensitive-notification-token");
    expect(sleeps).toHaveLength(0);
  });

  test("transport errors cannot expose endpoint query credentials in propagated errors", async () => {
    const canary = "notification-secret-query-canary";
    const { fetchImpl, sleep } = makeFetchSequence(
      Array.from(
        { length: WEBHOOK_MAX_ATTEMPTS },
        () => new Error(`request failed https://hook.example/post?key=${canary}`),
      ),
    );
    const adapter = new WebhookNotificationAdapter({
      exec: tdb.db,
      url: `https://hook.example/post?key=${canary}`,
      fetchImpl,
      sleepMs: sleep,
    });
    try {
      await adapter.send(delivery);
      throw new Error("expected delivery failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("webhook delivery failed: network_error");
      expect((error as Error).message).not.toContain(canary);
    }
  });
});
