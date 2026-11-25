import { expect, test } from "bun:test";
import { RequestMetaSchema } from "../request-meta-schema.ts";
import {
  sensitiveFailure,
  sensitiveRequestMeta,
  sensitiveStatusClass,
} from "../sensitive-payload.ts";
import type { RequestMeta } from "../types.ts";

const connectorId = "11111111-1111-4111-8111-111111111111";

const httpMeta = {
  driver: "http",
  method: "GET",
  url: "https://api.example.test/private?token=SECRET",
  status: 401,
  connector: {
    step_key: "fetch",
    connector_id: connectorId,
    connector_slug: "crm",
    driver: "http",
    requested_environment: "prod",
    resolved_environment: "prod",
    auth_method: "bearer",
    base_url: "https://api.example.test",
  },
  extras: { body: "PRIVATE" },
} as unknown as RequestMeta;

test("a sensitive step without a failure keeps only the connector id and slug", () => {
  const meta = sensitiveRequestMeta(httpMeta);
  expect(meta).toEqual({
    driver: "sensitive",
    connector: { connector_id: connectorId, connector_slug: "crm" },
  });
  expect(RequestMetaSchema.parse(meta)).toEqual(meta as never);
  expect(JSON.stringify(meta)).not.toContain("example.test");
  expect(JSON.stringify(meta)).not.toContain("PRIVATE");
  expect(JSON.stringify(meta)).not.toContain("401");
});

const failedMeta = {
  ...httpMeta,
  status: undefined,
  digest: {
    header_keys: ["authorization", "x-private-SECRET"],
    query_keys: ["token"],
    body_kind: "object",
    placeholder_types: { "input.body.app.argv": "array", "input.name": "string" },
    body_size: "<10KB",
  },
} as unknown as RequestMeta;

const upstreamError = {
  code: "http_4xx",
  message: "401 Unauthorized: token abc123 for jane@example.com",
  upstream_status: 401,
  response_body_excerpt: '{"error":{"code":"invalid_token_PRIVATE"}}',
  response_headers: { "www-authenticate": "Bearer realm=PRIVATE" },
  resolved_url: "https://api.example.test/private?token=SECRET",
};

test("a sensitive failure keeps the status class, placeholder types and body size", () => {
  const meta = sensitiveRequestMeta(failedMeta, upstreamError);
  expect(meta).toEqual({
    driver: "sensitive",
    connector: { connector_id: connectorId, connector_slug: "crm" },
    status_class: "4xx",
    placeholder_types: { "input.body.app.argv": "array", "input.name": "string" },
    body_size: "<10KB",
  });
  expect(RequestMetaSchema.parse(meta)).toEqual(meta as never);
  const stored = JSON.stringify(meta);
  for (const hidden of [
    "401",
    "invalid_token",
    "PRIVATE",
    "SECRET",
    "abc123",
    "jane@example.com",
    "example.test",
    "authorization",
    "www-authenticate",
  ])
    expect(stored).not.toContain(hidden);
});

test("a server error, a network failure and a timeout read as their class", () => {
  const classOf = (error: unknown) =>
    (sensitiveRequestMeta(failedMeta, error) as { status_class?: string }).status_class;
  expect(classOf({ code: "http_5xx", upstream_status: 503 })).toBe("5xx");
  expect(classOf({ code: "connection", message: "ECONNREFUSED 10.0.0.7" })).toBe("network");
  expect(classOf({ code: "step_timeout", message: "request exceeded 30000ms" })).toBe("timeout");
  expect(classOf({ code: "driver_exploded" })).toBeUndefined();
});

test("redacting an already redacted failure keeps the same diagnostics", () => {
  const once = sensitiveRequestMeta(failedMeta, upstreamError);
  const twice = sensitiveRequestMeta(once, sensitiveFailure("http_4xx", "x", "4xx"));
  expect(twice).toEqual(once);
});

test("a failure without request meta still keeps its class", () => {
  expect(sensitiveRequestMeta(null, { code: "connection" })).toEqual({
    driver: "sensitive",
    status_class: "network",
  });
  expect(sensitiveRequestMeta(undefined, { code: "driver_exploded" })).toBeNull();
});

test("the stored failure names its class but never the exact status or upstream code", () => {
  const failure = sensitiveFailure(
    upstreamError.code,
    upstreamError.message,
    sensitiveStatusClass(failedMeta, upstreamError),
  );
  expect(failure).toMatchObject({ code: "sensitive_execution_failure", status_class: "4xx" });
  expect(JSON.stringify(failure)).not.toContain("401");
  expect(JSON.stringify(failure)).not.toContain("invalid_token");
  expect(sensitiveFailure("driver_exploded", "x", null)).not.toHaveProperty("status_class");
});

test("a sensitive step without pagination or connector has no request meta", () => {
  expect(sensitiveRequestMeta(null)).toBeNull();
  expect(
    sensitiveRequestMeta({
      driver: "sandbox",
      ticks: 1,
      duration_ms: 1,
      peak_memory_bytes: null,
    } as RequestMeta),
  ).toBeNull();
});
