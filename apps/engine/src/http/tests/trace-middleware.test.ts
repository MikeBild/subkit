// Trace middleware accepts an inbound `x-sk-trace-id` (or `x-trace-id`)
// header so the CLI's debug.log records and the engine's structured
// logs share one id. Also rejects malformed values to prevent
// log-injection.

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { traceMiddleware } from "../middleware/trace.ts";
import type { AppEnv } from "../openapi.ts";

function appWithTrace() {
  const app = new Hono<AppEnv>();
  app.use("*", traceMiddleware());
  app.get("/echo", (c) => c.json({ trace_id: c.get("trace_id") }));
  return app;
}

describe("traceMiddleware", () => {
  test("uses an inbound x-sk-trace-id when shape is valid", async () => {
    const app = appWithTrace();
    const res = await app.request("/echo", {
      headers: { "x-sk-trace-id": "cli-abc12345defgh" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trace_id: string };
    expect(body.trace_id).toBe("cli-abc12345defgh");
    expect(res.headers.get("x-trace-id")).toBe("cli-abc12345defgh");
  });

  test("uses x-trace-id when x-sk-trace-id is absent", async () => {
    const app = appWithTrace();
    const res = await app.request("/echo", {
      headers: { "x-trace-id": "cli-zzzzzzzzzzzzz" },
    });
    const body = (await res.json()) as { trace_id: string };
    expect(body.trace_id).toBe("cli-zzzzzzzzzzzzz");
  });

  test("ignores malformed inbound trace ids and generates a fresh one", async () => {
    const app = appWithTrace();
    const res = await app.request("/echo", {
      headers: { "x-sk-trace-id": "../../etc/passwd" },
    });
    const body = (await res.json()) as { trace_id: string };
    expect(body.trace_id).not.toBe("../../etc/passwd");
    expect(body.trace_id.length).toBeGreaterThanOrEqual(8);
  });

  test("generates a fresh trace id when no inbound header is set", async () => {
    const app = appWithTrace();
    const res = await app.request("/echo");
    const body = (await res.json()) as { trace_id: string };
    expect(body.trace_id.length).toBeGreaterThanOrEqual(8);
  });
});
