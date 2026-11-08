import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { PendingElicitationBlockedError } from "../../conversations/service/shared.ts";
import { LlmTimeoutError } from "../../conversations/turn-failure.ts";
import { CatalogVocabularyBusyError } from "../../db/catalog-vocabulary.ts";
import { BadRequestError, ConflictError, HttpError, UnprocessableEntityError } from "../errors.ts";
import { errorMiddleware, mapKnownErrorResponse } from "../middleware/error.ts";
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
    if (res.status >= 400) {
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBeTruthy();
      expect(body.hint).toBeUndefined();
      expect(body.retry_after).toBeUndefined();
    }
  });
});

describe("error envelope wire — 429 hint + retry_after", () => {
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    const app = new Hono<AppEnv>();
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

describe("error envelope wire — a model that timed out", () => {
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    const app = new Hono<AppEnv>();
    app.onError((err, c) => {
      const known = mapKnownErrorResponse(c, err);
      if (known) return known;
      return c.json({ code: "internal_error", message: String(err) }, 500);
    });
    app.get("/__test__/throw-llm-timeout", () => {
      throw new LlmTimeoutError("first_chunk", 120_000);
    });
    app.get("/__test__/throw-sdk-timeout", () => {
      throw new DOMException("Step timeout of 5000ms exceeded", "TimeoutError");
    });
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    const addr = (server as unknown as { address: () => { port: number } | null }).address();
    if (!addr || typeof addr !== "object") throw new Error("test server address resolution failed");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server?.close();
  });

  test("the loop's timeout is a 504 llm_timeout with the same wording and details as the SSE frame", async () => {
    const res = await fetch(`${baseUrl}/__test__/throw-llm-timeout`);
    expect(res.status).toBe(504);
    const body = (await res.json()) as ErrorBody;
    expect(body.code).toBe("llm_timeout");
    expect(body.message).toBe("Timed out after 120 s");
    expect(body.details).toEqual({ phase: "first_chunk", timeout_ms: 120_000 });
    expect(body.hint).toContain("retry");
  });

  test("a raw SDK timeout is classified the same way", async () => {
    const res = await fetch(`${baseUrl}/__test__/throw-sdk-timeout`);
    expect(res.status).toBe(504);
    const body = (await res.json()) as ErrorBody;
    expect(body.code).toBe("llm_timeout");
    expect(body.message).toBe("Timed out after 5 s");
    expect(body.details).toEqual({ phase: "step", timeout_ms: 5000 });
  });
});

describe("error envelope wire — conversation turn conflicts", () => {
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    const app = new Hono<AppEnv>();
    app.use("*", errorMiddleware());
    app.onError((err, c) => {
      const known = mapKnownErrorResponse(c, err);
      if (known) return known;
      return c.json({ code: "internal_error", message: String(err) }, 500);
    });
    app.get("/__test__/throw-pending-elicitation", () => {
      throw new PendingElicitationBlockedError({
        id: "elicitation-1",
        tool_name: "ask_user_confirm",
        summary: "confirm proceed",
      });
    });
    app.get("/__test__/throw-abort/:reason", (c) => {
      throw c.req.param("reason");
    });
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    const addr = (server as unknown as { address: () => { port: number } | null }).address();
    if (!addr || typeof addr !== "object") throw new Error("test server address resolution failed");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server?.close();
  });

  test("a pending dialog is a 409 with its code and the pending dialog", async () => {
    const res = await fetch(`${baseUrl}/__test__/throw-pending-elicitation`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.code).toBe("pending_elicitation_blocked");
    expect(body.message).toBe("resolve the pending dialog before sending another prompt");
    expect(body.details).toEqual({
      conversation_status: "awaiting_input",
      pending_elicitation: {
        id: "elicitation-1",
        tool_name: "ask_user_confirm",
        summary: "confirm proceed",
      },
    });
  });

  test.each(["conversation_turn_superseded", "conversation_cancelled"])(
    "a bare %s abort reason is a 409 with that code",
    async (reason) => {
      const res = await fetch(`${baseUrl}/__test__/throw-abort/${reason}`);
      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe(reason);
    },
  );

  test("an unknown bare string stays an internal error", async () => {
    const res = await fetch(`${baseUrl}/__test__/throw-abort/something_else`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.code).toBe("internal_error");
  });
});

describe("error envelope wire — a tenant catalog that stayed busy", () => {
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    const app = new Hono<AppEnv>();
    app.onError((err, c) => {
      const known = mapKnownErrorResponse(c, err);
      if (known) return known;
      return c.json({ code: "internal_error", message: String(err) }, 500);
    });
    app.get("/__test__/busy", () => {
      throw new CatalogVocabularyBusyError("Catalog vocabulary stayed busy; retry the operation");
    });
    app.get("/__test__/deadlock", () => {
      throw new Error("write failed", {
        cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
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

  test("a lock wait that ran out answers 409 catalog_vocabulary_changed", async () => {
    const res = await fetch(`${baseUrl}/__test__/busy`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).code).toBe("catalog_vocabulary_changed");
  });

  test("a deadlock while waiting answers the same retryable 409", async () => {
    const res = await fetch(`${baseUrl}/__test__/deadlock`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).code).toBe("catalog_vocabulary_changed");
  });
});
