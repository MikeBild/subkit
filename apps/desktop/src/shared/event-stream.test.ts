import { describe, expect, test } from "bun:test";
import {
  refusalMessage,
  runEventStream,
  type StreamDeps,
  type StreamResponse,
  type StreamStatus,
} from "./event-stream.ts";

function sse(text: string): StreamResponse {
  return {
    status: 200,
    ok: true,
    body: new Response(text).body,
    json: async () => null,
  };
}

function refusal(status: number, body: unknown): StreamResponse {
  return { status, ok: false, body: null, json: async () => body };
}

function harness(responses: Array<StreamResponse | Error>) {
  const controller = new AbortController();
  const requests: Array<Record<string, string>> = [];
  const sleeps: number[] = [];
  const deps: StreamDeps = {
    fetch: async (_url, init) => {
      requests.push(init.headers);
      const next = responses.shift();
      if (!next) {
        controller.abort();
        throw new Error("stopped");
      }
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    jitter: () => 1,
  };
  return { controller, requests, sleeps, deps };
}

describe("runEventStream", () => {
  test("delivers events, then reconnects with the last event id and backoff", async () => {
    const h = harness([
      sse('id: 7\nevent: connector.auth_failed\ndata: {"attention_id":"task:1"}\n\n'),
      new Error("network down"),
      sse("event: hello\ndata: {}\n\n"),
    ]);
    const statuses: StreamStatus[] = [];
    const events: string[] = [];
    const errors: unknown[] = [];
    const outcome = await runEventStream({
      url: "https://subkit.example.com/v1/cockpit/events/stream",
      lastEventId: "3",
      signal: h.controller.signal,
      deps: h.deps,
      onEvent: (event) => events.push(`${event.id}:${event.event}`),
      onStatus: (status) => statuses.push(status),
      onError: (error) => errors.push(error),
    });
    expect(outcome).toBe("stopped");
    expect(events).toEqual(["7:connector.auth_failed", "null:hello"]);
    expect(h.requests.map((headers) => headers["last-event-id"])).toEqual(["3", "7", "7", "7"]);
    expect(h.requests[0]?.accept).toBe("text/event-stream");
    expect(h.sleeps).toEqual([1000, 2000, 1000]);
    expect(statuses).toEqual(["connecting", "online", "offline", "online", "offline"]);
    expect(errors).toHaveLength(1);
  });

  test("stops with an expired session on 401", async () => {
    const h = harness([refusal(401, { code: "installation_session_required" })]);
    const statuses: StreamStatus[] = [];
    const outcome = await runEventStream({
      url: "https://subkit.example.com/x",
      lastEventId: null,
      signal: h.controller.signal,
      deps: h.deps,
      onEvent: () => {},
      onStatus: (status) => statuses.push(status),
    });
    expect(outcome).toBe("expired");
    expect(statuses).toEqual(["connecting", "expired"]);
    expect(h.requests[0]?.["last-event-id"]).toBeUndefined();
    expect(h.sleeps).toEqual([]);
  });

  test("stops with a revoked device when the server says so", async () => {
    const h = harness([refusal(403, { code: "installation_revoked" })]);
    const outcome = await runEventStream({
      url: "https://subkit.example.com/x",
      lastEventId: null,
      signal: h.controller.signal,
      deps: h.deps,
      onEvent: () => {},
      onStatus: () => {},
    });
    expect(outcome).toBe("revoked");
  });

  test("treats a server error as offline and keeps trying", async () => {
    const h = harness([refusal(503, null), refusal(502, null)]);
    const statuses: StreamStatus[] = [];
    await runEventStream({
      url: "https://subkit.example.com/x",
      lastEventId: null,
      signal: h.controller.signal,
      deps: h.deps,
      onEvent: () => {},
      onStatus: (status) => statuses.push(status),
    });
    expect(h.sleeps).toEqual([1000, 2000]);
    expect(statuses.filter((status) => status === "online")).toEqual([]);
  });
});

describe("refusalMessage", () => {
  test("names the status, the code and the trace id of a refused stream", () => {
    expect(
      refusalMessage(409, { code: "tenant_context_changed" }, "4bf92f3577b34da6a3ce929d0e0e4736"),
    ).toBe(
      "event stream answered 409 code=tenant_context_changed trace=4bf92f3577b34da6a3ce929d0e0e4736",
    );
    expect(refusalMessage(502, null, null)).toBe("event stream answered 502");
    expect(refusalMessage(500, { code: "a b" }, "x")).toBe("event stream answered 500");
  });
});
