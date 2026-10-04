import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { BadRequestError, ConflictError, HttpError, UnprocessableEntityError } from "../errors.ts";
import { mapKnownErrorResponse } from "../middleware/error.ts";
import type { AppEnv } from "../openapi.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

describe("HttpError envelope shape", () => {
  test("a subclass details bag lands in details", () => {
    const err = new BadRequestError("nope", { field: "x" });
    expect(err.toBody()).toEqual({
      code: "bad_request",
      message: "nope",
      details: { field: "x" },
    });
    expect(err.hint).toBeUndefined();
    expect(err.retry_after).toBeUndefined();
  });

  test("a subclass details bag with a `hint` key stays inside details", () => {
    const err = new ConflictError("conflict", { hint: "retry the merge", foo: 1 });
    const body = err.toBody();
    expect(body.code).toBe("conflict");
    expect(body.hint).toBeUndefined();
    expect(body.details).toEqual({ hint: "retry the merge", foo: 1 });
  });

  test("HttpError options carry hint and details", () => {
    const err = new HttpError(409, "conflict", "stale write", {
      hint: "refetch the resource",
      details: { foo: 1 },
    });
    const body = err.toBody();
    expect(body.code).toBe("conflict");
    expect(body.hint).toBe("refetch the resource");
    expect(body.details).toEqual({ foo: 1 });
  });

  test("HttpError options carry retry_after", () => {
    const err = new HttpError(429, "rate_limited", "slow down", { retry_after: 30 });
    const body = err.toBody();
    expect(body.retry_after).toBe(30);
    expect(body.code).toBe("rate_limited");
  });

  test("UnprocessableEntityError keeps its details verbatim", () => {
    const err = new UnprocessableEntityError("bad shape", {
      hint: "fix the schema",
      details: { path: "$.steps[0]" },
    });
    expect(err.hint).toBeUndefined();
    expect(err.details).toEqual({ hint: "fix the schema", details: { path: "$.steps[0]" } });
  });
});

let ctx: HttpTestServer;
beforeAll(async () => {
  ctx = await createHttpTestServer("error-envelope");
});
afterAll(async () => {
  await ctx.cleanup();
});

interface ErrorBody {
  code: string;
  message: string;
  trace_id?: string;
  hint?: string;
  retry_after?: number;
  details?: Record<string, unknown>;
}

describe("error envelope over HTTP", () => {
  test("401 envelope carries code + message + trace_id", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/identity/tenants`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.code).toBe("unauthorized");
    expect(body.message).toBeTruthy();
    expect(typeof body.trace_id === "string" || body.trace_id === undefined).toBe(true);
    expect(body.hint).toBeUndefined();
    expect(body.retry_after).toBeUndefined();
  });

  test("404 envelope omits hint/retry_after when not set", async () => {
    const res = await fetch(
      `${ctx.baseUrl}/v1/identity/tenants/00000000-0000-0000-0000-000000000000`,
      {
        headers: { authorization: `Bearer ${ctx.apiKey}` },
      },
    );
    // Either 404 (not found) or 200 (route only lists own tenant) — assert
    // that *if* it's an error, the envelope doesn't leak unset fields.
    if (res.status >= 400) {
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBeTruthy();
      expect(body.hint).toBeUndefined();
      expect(body.retry_after).toBeUndefined();
    }
  });
});

// R2-W5 review fix: end-to-end coverage that a 429 emits BOTH the
// `hint` + `retry_after` body fields AND the `Retry-After` HTTP
// header in a single response. The unit tests above exercise the
// envelope construction in isolation; this block stands up the
// real `errorMiddleware` against a synthetic route that throws
// `new HttpError(429, …, { hint, retry_after })` and
// asserts the wire response.
describe("error envelope wire — 429 hint + retry_after", () => {
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    const app = new Hono<AppEnv>();
    // Hono's router resolves `app.onError(...)` BEFORE upstream
    // middleware catch blocks see a synchronously thrown error
    // (apps/engine/src/http/server.ts:118). The standalone test app
    // therefore wires the same `mapKnownErrorResponse` mapping the
    // engine uses — the assertion below pins the wire shape end-to-end.
    app.onError((err, c) => {
      const known = mapKnownErrorResponse(c, err);
      if (known) return known;
      return c.json({ code: "internal_error", message: String(err) }, 500);
    });
    app.get("/__test__/throw-429", () => {
      throw new HttpError(429, "rate_limited", "slow your roll", {
        hint: "wait 30s and retry",
        retry_after: 30,
      });
    });
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    const addr = (server as unknown as { address: () => { port: number } | null }).address();
    if (!addr || typeof addr !== "object") throw new Error("test server address resolution failed");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server?.close();
  });

  test("body carries `hint` + `retry_after`; header carries `Retry-After`", async () => {
    const res = await fetch(`${baseUrl}/__test__/throw-429`);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    const body = (await res.json()) as ErrorBody;
    expect(body.code).toBe("rate_limited");
    expect(body.message).toBe("slow your roll");
    expect(body.hint).toBe("wait 30s and retry");
    expect(body.retry_after).toBe(30);
  });
});
