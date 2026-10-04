import { describe, expect, test } from "bun:test";
import { WEBHOOK_MAX_ATTEMPTS, WebhookNotificationAdapter } from "../channels/webhook.ts";

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
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
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
    tenant_id: "tenant-1",
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
      url: "http://hook.example/post",
      secret: "shh",
      fetchImpl,
      sleepMs: sleep,
    });
    await adapter.send(delivery);
    expect(calls[0]?.headers["x-subkit-secret"]).toBe("shh");
  });
});
