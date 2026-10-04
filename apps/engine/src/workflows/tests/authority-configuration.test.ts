import { expect, test } from "bun:test";
import { authorityConnectorDigest } from "../authority-configuration.ts";

const connector = {
  id: "00000000-0000-4000-8000-000000000001",
  driver: "http" as const,
  environment: "dev" as const,
  auth_type: "none" as const,
  base_url: "https://example.test",
  dsn: null,
  config: {},
  template_slug: null,
  template_source: null,
  template_version: null,
  template_snapshot: null,
};

test("every material connector field participates in the dispatch digest", () => {
  const original = authorityConnectorDigest(connector);
  const alternatives: Array<Parameters<typeof authorityConnectorDigest>[0]> = [
    { ...connector, id: "00000000-0000-4000-8000-000000000002" },
    { ...connector, driver: "graphql" },
    { ...connector, environment: "prod" },
    { ...connector, auth_type: "bearer" },
    { ...connector, base_url: "https://other.example.test" },
    { ...connector, dsn: "postgres://example.test/database" },
    { ...connector, config: { headers: { "X-Account": "different" } } },
    { ...connector, template_slug: "different" },
    { ...connector, template_source: "builtin" },
    { ...connector, template_version: 2 },
    { ...connector, template_snapshot: { purpose: "different" } },
    null,
  ];
  for (const alternative of alternatives)
    expect(authorityConnectorDigest(alternative)).not.toBe(original);
});

test("configuration ordering and operational health never widen or invalidate a boundary", () => {
  const first = { ...connector, config: { first: 1, second: 2 } };
  const second = {
    ...connector,
    config: { second: 2, first: 1 },
    circuit_failure_count: 7,
    enabled: true,
  };
  expect(authorityConnectorDigest(first)).toBe(authorityConnectorDigest(second));
  expect(authorityConnectorDigest(null)).toBe(authorityConnectorDigest(undefined));
});

test("the captured digest cannot mutate along with a subsequently changed connector object", () => {
  const mutable = { ...connector, config: { recipient: "reviewed@example.test" } };
  const captured = authorityConnectorDigest(mutable);
  mutable.config.recipient = "different@example.test";
  expect(authorityConnectorDigest(mutable)).not.toBe(captured);
});
