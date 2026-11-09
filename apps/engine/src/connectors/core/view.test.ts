import { expect, test } from "bun:test";
import fc from "fast-check";
import { type ConnectorViewFacts, toConnectorView } from "./view.ts";

function facts(overrides: Partial<ConnectorViewFacts> = {}): ConnectorViewFacts {
  return {
    id: "connector",
    tenant_id: "tenant",
    slug: "daily-api",
    display_name: "Daily API",
    description: null,
    description_source: "other",
    category: "ops",
    category_source: "human",
    driver: "http",
    environment: "dev",
    auth_type: "bearer",
    base_url: null,
    dsn: null,
    config: null,
    operator_quirks: null,
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    self_description: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-02T00:00:00.000Z"),
    enabled: null,
    last_error: null,
    circuit_state: null,
    circuit_opened_at: null,
    circuit_failure_count: null,
    circuit_threshold: null,
    circuit_reset_ms: null,
    needs_reauth: null,
    auth_failed_at: null,
    auth_failed_reason: null,
    health_state: null,
    health_reason: null,
    health_error_code: null,
    sunset_at: null,
    successor_uri: null,
    ...overrides,
  };
}

test("row projection preserves values and applies the historical nullable defaults", () => {
  const config = Object.freeze({ oauth: Object.freeze({ scope: "read" }) });
  const input = Object.freeze(
    facts({
      config,
      operator_quirks: Object.freeze({ auth: "retry" }),
      template_source: "builtin",
      template_snapshot: Object.freeze({ version: 1 }),
      self_description: Object.freeze({ links: [] }),
      circuit_state: "half-open",
      circuit_failure_count: 2,
      circuit_threshold: 7,
      circuit_reset_ms: 5_000,
      needs_reauth: true,
      health_state: "degraded",
    }),
  );
  const before = JSON.stringify(input);
  expect(toConnectorView(input)).toMatchObject({
    id: "connector",
    description: null,
    description_source: "llm",
    category: "ops",
    category_source: "human",
    config,
    circuit_state: "half-open",
    circuit_failure_count: 2,
    circuit_threshold: 7,
    circuit_reset_ms: 5_000,
    needs_reauth: true,
    health_state: "degraded",
  });
  expect(toConnectorView(facts())).toMatchObject({
    config: {},
    operator_quirks: {},
    self_description: {},
    enabled: true,
    circuit_state: "closed",
    circuit_failure_count: 0,
    circuit_threshold: 5,
    circuit_reset_ms: 300_000,
    needs_reauth: false,
    health_state: "ok",
  });
  expect(JSON.stringify(input)).toBe(before);
});

test("view projection is deterministic for frozen facts", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.integer({ min: 0, max: 10 }), (enabled, failures) => {
      const input = Object.freeze(facts({ enabled, circuit_failure_count: failures }));
      const before = JSON.stringify(input);
      expect(toConnectorView(input)).toEqual(toConnectorView(input));
      expect(JSON.stringify(input)).toBe(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});

test("connection, template and recovery facts remain available in the public view", () => {
  const populated = Object.freeze({
    base_url: "https://api.example.test/v1",
    dsn: "postgres://localhost/example",
    template_slug: "example-api",
    template_name: "Example API",
    template_version: 3,
    template_snapshot: Object.freeze({ driver: "http", version: 3 }),
    last_error: "upstream unavailable",
    circuit_opened_at: new Date("2026-01-03T00:00:00Z"),
    auth_failed_at: new Date("2026-01-04T00:00:00Z"),
    auth_failed_reason: "token expired",
    health_reason: "authentication required",
    health_error_code: "needs_reauth",
    sunset_at: new Date("2027-01-01T00:00:00Z"),
    successor_uri: "https://api.example.test/v2",
  });
  const input = Object.freeze(facts(populated));
  expect(toConnectorView(input)).toMatchObject(populated);
  expect(toConnectorView(facts({ base_url: "", template_version: 0 }))).toMatchObject({
    base_url: "",
    template_version: 0,
  });
});
