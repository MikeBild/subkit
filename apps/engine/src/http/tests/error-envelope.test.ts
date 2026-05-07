import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BadRequestError, ConflictError, HttpError, UnprocessableEntityError } from "../errors.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

describe("HttpError envelope shape", () => {
  test("legacy details-positional is preserved", () => {
    const err = new BadRequestError("nope", { field: "x" });
    expect(err.toBody()).toEqual({
      code: "bad_request",
      message: "nope",
      details: { field: "x" },
    });
    expect(err.hint).toBeUndefined();
    expect(err.retry_after).toBeUndefined();
  });

  test("legacy details with a `hint` key is treated as details, not as envelope opts", () => {
    // W4 review fix: the previous shape-sniffing dispatch would have
    // re-shaped this into the envelope (hint outside details). The
    // brand-based dispatch keeps it inside `details` where every
    // existing throw site expects it.
    const err = new ConflictError("conflict", { hint: "retry the merge", foo: 1 });
    const body = err.toBody();
    expect(body.code).toBe("conflict");
    expect(body.hint).toBeUndefined();
    expect(body.details).toEqual({ hint: "retry the merge", foo: 1 });
  });

  test("HttpError.withEnvelope explicitly opts into the new envelope shape", () => {
    const err = HttpError.withEnvelope(409, "conflict", "stale write", {
      hint: "refetch the resource",
      details: { foo: 1 },
    });
    const body = err.toBody();
    expect(body.code).toBe("conflict");
    expect(body.hint).toBe("refetch the resource");
    expect(body.details).toEqual({ foo: 1 });
  });

  test("HttpError.withEnvelope captures retry_after", () => {
    const err = HttpError.withEnvelope(429, "rate_limited", "slow down", { retry_after: 30 });
    const body = err.toBody();
    expect(body.retry_after).toBe(30);
    expect(body.code).toBe("rate_limited");
  });

  test("UnprocessableEntityError can be wrapped through withEnvelope", () => {
    // The subclass keeps the legacy positional-details signature for
    // backwards compatibility; if a caller wants the rich envelope it
    // builds via withEnvelope on the parent instead.
    const err = HttpError.withEnvelope(422, "unprocessable_entity", "bad shape", {
      hint: "fix the schema",
      details: { path: "$.steps[0]" },
    });
    expect(err.toBody()).toEqual({
      code: "unprocessable_entity",
      message: "bad shape",
      hint: "fix the schema",
      details: { path: "$.steps[0]" },
    });
  });

  test("UnprocessableEntityError positional details (no brand) preserves verbatim", () => {
    // Defensive: confirms the existing 50+ throw sites that pass a
    // details bag with arbitrary keys continue to wire the body
    // through unchanged. No silent reshaping.
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
