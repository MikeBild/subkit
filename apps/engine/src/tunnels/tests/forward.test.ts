import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { createTunnelTestCtx, startLocalTargetServer, type TunnelTestCtx } from "./setup.ts";

let ctx: TunnelTestCtx;
let target: { url: string; stop: () => Promise<void> };
let calls: Array<{ method: string; path: string; body: string | null }>;

// Bun test default beforeAll timeout (5s) is not enough when ~15 other
// suites are simultaneously creating per-suite databases. Give the DB
// + Bun.serve setup a generous budget.
beforeAll(async () => {
  ctx = await createTunnelTestCtx("forward");
  calls = [];
  target = startLocalTargetServer(async (req) => {
    const url = new URL(req.url);
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
    calls.push({ method: req.method, path: url.pathname + url.search, body });
    return new Response(JSON.stringify({ echoed: url.pathname, ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}, 60_000);

afterAll(async () => {
  await target.stop();
  await ctx.cleanup();
});

describe("tunnel forward", () => {
  test("engine forwards request through tunnel to local target and relays response", async () => {
    const ws = new WebSocket(ctx.wsUrl, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    const ready = new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "register",
            agent_version: "test-forward",
            targets: [{ name: "local", local_base_url: target.url }],
          }),
        );
      });
      const onMsg = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString()) as {
          type: string;
          request_id?: string;
          method?: string;
          path?: string;
          headers?: Record<string, string>;
          body?: string | null;
        };
        if (frame.type === "register_ack") {
          resolve();
          return;
        }
        if (frame.type === "request") {
          // Ship the request to the local target and reply with a response frame.
          const url = `${target.url}${frame.path}`;
          const init: RequestInit = {
            method: frame.method ?? "GET",
            headers: frame.headers ?? {},
          };
          if (frame.body != null && frame.method !== "GET" && frame.method !== "HEAD") {
            init.body = frame.body;
          }
          fetch(url, init)
            .then(async (res) => {
              const text = await res.text();
              const headers: Record<string, string> = {};
              res.headers.forEach((v, k) => {
                headers[k] = v;
              });
              ws.send(
                JSON.stringify({
                  type: "response",
                  request_id: frame.request_id,
                  status: res.status,
                  headers,
                  body: text,
                }),
              );
            })
            .catch((err) => {
              ws.send(
                JSON.stringify({
                  type: "response",
                  request_id: frame.request_id,
                  status: 0,
                  headers: {},
                  body: null,
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            });
        }
      };
      ws.on("message", onMsg);
      ws.once("error", reject);
    });
    await ready;

    const res = await ctx.registry.forwardRequest(
      ctx.tenantId,
      "local",
      {
        target: "local",
        method: "GET",
        path: "/ping?x=1",
        headers: { "x-trace": "abc" },
        body: null,
      },
      { timeoutMs: 20_000 },
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain("echoed");
    expect(res.body).toContain("/ping");
    // The local target must have seen the exact request the engine sent.
    expect(calls.some((c) => c.method === "GET" && c.path === "/ping?x=1")).toBe(true);
    ws.close();
  }, 30_000);
});
