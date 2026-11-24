import { expect, test } from "bun:test";
import { RequestMetaSchema } from "../request-meta-schema.ts";
import { sensitiveRequestMeta } from "../sensitive-payload.ts";
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

test("a sensitive failure keeps only the connector id and slug", () => {
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
