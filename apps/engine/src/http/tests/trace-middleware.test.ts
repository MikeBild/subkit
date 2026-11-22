import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  assertOperatorKeyAllowed,
  modelTenantContext,
} from "../../llm/runtime/operator-key-guard.ts";
import { getContext, withContext } from "../../logging/context.ts";
import { parseTraceparent, traceMiddleware } from "../middleware/trace.ts";
import type { AppEnv } from "../openapi.ts";

function appWithTrace() {
  const app = new Hono<AppEnv>();
  app.use("*", traceMiddleware());
  app.get("/echo", (c) => c.json({ trace_id: c.get("trace_id") }));
  return app;
}

describe("traceMiddleware", () => {
  test("continues an inbound W3C trace with a fresh server span", async () => {
    const app = appWithTrace();
    const inbound = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const res = await app.request("/echo", { headers: { traceparent: inbound } });
    const body = (await res.json()) as { trace_id: string };
    expect(body.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    const outbound = res.headers.get("traceparent") ?? "";
    expect(outbound).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    expect(outbound).not.toBe(inbound);
    expect(outbound.split("-")[2]).not.toBe("00f067aa0ba902b7");
  });

  test("rejects W3C all-zero trace and parent ids", () => {
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull();
  });

  test("uses an inbound x-subkit-trace-id when shape is valid", async () => {
    const app = appWithTrace();
    const res = await app.request("/echo", {
      headers: { "x-subkit-trace-id": "cli-abc12345defgh" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trace_id: string };
    expect(body.trace_id).toBe("cli-abc12345defgh");
    expect(res.headers.get("x-trace-id")).toBe("cli-abc12345defgh");
  });

  test("uses x-trace-id when x-subkit-trace-id is absent", async () => {
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
      headers: { "x-subkit-trace-id": "../../etc/passwd" },
    });
    const body = (await res.json()) as { trace_id: string };
    expect(body.trace_id).not.toBe("../../etc/passwd");
    expect(body.trace_id.length).toBeGreaterThanOrEqual(8);
  });

  test("generates a fresh trace id when no inbound header is set", async () => {
    const app = appWithTrace();
    const res = await app.request("/echo");
    const body = (await res.json()) as { trace_id: string };
    expect(body.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
  });
});

describe("native HTTP request context", () => {
  test("separates the boot identity from anonymous model initialization and refuses an unknown tenant", async () => {
    const systemTenant = "00000000-0000-0000-0000-000000000000";
    const unknownTenant = "00000000-0000-4000-8000-000000000123";
    let tenantLookups = 0;
    const enteredTenants: Array<string | undefined> = [];
    const app = new Hono<AppEnv>();
    app.use("*", traceMiddleware());
    app.get("/probe", async (c) => {
      const boundTenant = c.req.query("explicit") ? unknownTenant : modelTenantContext();
      try {
        await assertOperatorKeyAllowed(boundTenant, undefined, {
          hostedAuth: () => false,
          tenantOrigin: async () => {
            tenantLookups++;
            return undefined;
          },
        });
        return c.json({ context: getContext(), model_tenant: boundTenant ?? null });
      } catch (error) {
        return c.json({ code: error instanceof Error ? error.name : "unexpected_error" }, 403);
      }
    });
    const bootContext = {
      tenant_id: systemTenant,
      actor_id: "boot",
      auth_via: "token_exchange" as const,
      execution_id: "boot-execution",
      workflow_id: "boot-workflow",
      execution_privacy: "sensitive" as const,
      trace_id: "boot-trace",
      request_source: "cli" as const,
    };
    const server = withContext(bootContext, () =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          enteredTenants.push(getContext().tenant_id);
          return app.fetch(request);
        },
      }),
    );
    try {
      const response = await fetch(`${server.url}probe`, {
        headers: { "x-trace-id": "request-context-proof" },
      });
      expect(enteredTenants).toEqual([systemTenant]);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.model_tenant).toBeNull();
      expect(body.context.trace_id).toBe("request-context-proof");
      expect(body.context.request_source).toBe("api");
      for (const field of [
        "tenant_id",
        "actor_id",
        "auth_via",
        "execution_id",
        "workflow_id",
        "execution_privacy",
      ]) {
        expect(body.context[field]).toBeUndefined();
      }
      expect(tenantLookups).toBe(0);
      const denied = await fetch(`${server.url}probe?explicit=1`);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ code: "LlmError" });
      expect(tenantLookups).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("preserves explicit background and queue context inheritance", async () => {
    await withContext(
      { tenant_id: "tenant-background", actor_id: "queue-worker", request_source: "queue" },
      async () => {
        await withContext({ execution_id: "queued-execution" }, async () => {
          await Promise.resolve();
          expect(getContext()).toEqual({
            tenant_id: "tenant-background",
            actor_id: "queue-worker",
            request_source: "queue",
            execution_id: "queued-execution",
          });
        });
        expect(getContext().tenant_id).toBe("tenant-background");
        expect(getContext().execution_id).toBeUndefined();
      },
    );
  });
});
