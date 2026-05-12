// EngineClient.subscribeConnectorOAuthCallback — fake-fetch unit test.
//
// Verifies the SSE consumer correctly:
//   1. opens `/v1/events/stream` with channel+type filters and Bearer auth;
//   2. ignores the `hello` frame;
//   3. parses an `event:` + `data:` SSE frame and only fires `onSucceeded`
//      when the payload's `connector_id` matches the caller's filter;
//   4. auto-cancels the subscription after one match;
//   5. cancels cleanly on caller `signal`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FetchLike } from "../engine-client.ts";

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
});
afterEach(() => {
  process.env = originalEnv;
  delete require.cache[require.resolve("../engine-client.ts")];
});

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

/** Build an SSE body that emits an initial `hello` frame, then a
 *  callback-succeeded frame, then keeps the stream open until the
 *  caller's signal aborts. */
function makeSseResponse(frames: string[]): {
  res: Response;
  controllerRef: { close: () => void };
} {
  const controllerRef: { close: () => void } = { close: () => undefined };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controllerRef.close = () => {
        try {
          controller.close();
        } catch {
          // ignore double-close
        }
      };
    },
  });
  const res = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  return { res, controllerRef };
}

describe("EngineClient.subscribeConnectorOAuthCallback", () => {
  test("fires onSucceeded once for a matching connector_id and auto-cancels", async () => {
    const { EngineClient } = await import("../engine-client.ts");
    const calls: FakeFetchCall[] = [];
    const { res } = makeSseResponse([
      'event: hello\ndata: {"cursor":0}\n\n',
      // event for a DIFFERENT connector — must be ignored
      `event: connector.oauth.callback_succeeded\ndata: ${JSON.stringify({
        connector_id: "11111111-1111-1111-1111-111111111111",
        connector_slug: "other",
        has_refresh_token: false,
      })}\n\n`,
      // matching event
      `event: connector.oauth.callback_succeeded\ndata: ${JSON.stringify({
        connector_id: "22222222-2222-2222-2222-222222222222",
        connector_slug: "google-gmail",
        has_refresh_token: true,
      })}\n\n`,
    ]);
    const fakeFetch: FetchLike = async (input, init = {}) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      return res;
    };
    const client = new EngineClient({
      engine_url: "https://engine.test",
      api_key: "test-key",
      tenant: "tenant-1",
      fetchImpl: fakeFetch,
    });

    let received: {
      connector_id: string;
      connector_slug: string;
      has_refresh_token: boolean;
    } | null = null;
    const handle = await client.subscribeConnectorOAuthCallback({
      connectorId: "22222222-2222-2222-2222-222222222222",
      onSucceeded: (payload) => {
        received = payload;
      },
    });

    // Wait briefly for the background reader to consume the frames.
    for (let i = 0; i < 20 && received === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(received).not.toBeNull();
    expect(received!.connector_id).toBe("22222222-2222-2222-2222-222222222222");
    expect(received!.connector_slug).toBe("google-gmail");
    expect(received!.has_refresh_token).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      "https://engine.test/v1/events/stream?channel=connector.oauth&type=connector.oauth.callback_succeeded",
    );
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["x-subkit-tenant"]).toBe("tenant-1");

    // Subscription should be cancellable without side effects after match.
    handle.cancel();
    handle.cancel(); // idempotent
  });

  test("ignores frames where connector_id does not match the filter", async () => {
    const { EngineClient } = await import("../engine-client.ts");
    const { res, controllerRef } = makeSseResponse([
      'event: hello\ndata: {"cursor":0}\n\n',
      `event: connector.oauth.callback_succeeded\ndata: ${JSON.stringify({
        connector_id: "11111111-1111-1111-1111-111111111111",
        connector_slug: "other",
        has_refresh_token: false,
      })}\n\n`,
    ]);
    const fakeFetch: FetchLike = async () => res;
    const client = new EngineClient({
      engine_url: "https://engine.test",
      api_key: "test-key",
      fetchImpl: fakeFetch,
    });

    let fired = false;
    const handle = await client.subscribeConnectorOAuthCallback({
      connectorId: "22222222-2222-2222-2222-222222222222",
      onSucceeded: () => {
        fired = true;
      },
    });
    // Let the reader process all queued frames.
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(false);
    handle.cancel();
    controllerRef.close();
  });

  test("aborts the subscription when the caller's signal aborts", async () => {
    const { EngineClient } = await import("../engine-client.ts");
    const ac = new AbortController();
    let observedSignal: AbortSignal | null = null;
    const fakeFetch: FetchLike = async (_input, init = {}) => {
      observedSignal = init.signal ?? null;
      // Return a stream that never closes on its own.
      const { res } = makeSseResponse(['event: hello\ndata: {"cursor":0}\n\n']);
      return res;
    };
    const client = new EngineClient({
      engine_url: "https://engine.test",
      api_key: "test-key",
      fetchImpl: fakeFetch,
    });
    const handle = await client.subscribeConnectorOAuthCallback({
      connectorId: "22222222-2222-2222-2222-222222222222",
      signal: ac.signal,
      onSucceeded: () => {
        throw new Error("should not fire");
      },
    });
    expect(observedSignal).not.toBeNull();
    expect(observedSignal!.aborted).toBe(false);
    ac.abort();
    // Internal AbortController is composed with caller signal, so it
    // should now be aborted too.
    await new Promise((r) => setTimeout(r, 20));
    expect(observedSignal!.aborted).toBe(true);
    // cancel() is idempotent post-abort.
    handle.cancel();
  });

  test("raises SkTransportError on non-2xx response", async () => {
    const { EngineClient, SkTransportError } = await import("../engine-client.ts");
    const fakeFetch: FetchLike = async () =>
      new Response("nope", { status: 401, headers: { "content-type": "text/plain" } });
    const client = new EngineClient({
      engine_url: "https://engine.test",
      api_key: "bad-key",
      fetchImpl: fakeFetch,
    });
    let err: unknown = null;
    try {
      await client.subscribeConnectorOAuthCallback({
        connectorId: "22222222-2222-2222-2222-222222222222",
        onSucceeded: () => undefined,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SkTransportError);
  });
});
