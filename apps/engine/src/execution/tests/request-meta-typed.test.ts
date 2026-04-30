// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` placeholder tokens are part of the tested grammar.
// Typed RequestMeta — strict discriminated union with non-optional
// `connector` on driver-keyed variants. The `connectorless` variant
// covers raw-url HTTP steps; the `error` variant covers pre-dispatch
// failures.

import { describe, expect, test } from "bun:test";
import { RequestMetaSchema } from "../request-meta-schema.ts";
import type { ConnectorResolutionSummary, RequestMeta } from "../types.ts";

const stubConnector: ConnectorResolutionSummary = {
  step_key: "demo_step",
  connector_id: "00000000-0000-0000-0000-000000000001",
  connector_slug: "demo",
  driver: "http",
  requested_environment: "dev",
  resolved_environment: "dev",
  auth_method: "bearer",
  base_url: "https://example.test",
  tunnel_target: null,
};

describe("RequestMeta · driver-discriminated union", () => {
  test("postgres variant carries query_preview + row_count + transaction + cursor + required connector", () => {
    const meta: RequestMeta = {
      driver: "postgres",
      query_preview: "SELECT 1",
      row_count: 1,
      transaction: false,
      cursor: false,
      connector: stubConnector,
    };
    if (meta.driver === "postgres") {
      expect(meta.row_count).toBe(1);
      expect(meta.connector.connector_slug).toBe("demo");
    }
  });

  test("s3 variant carries method + status + key + required connector", () => {
    const meta: RequestMeta = {
      driver: "s3",
      method: "GET",
      status: 200,
      key: "reports/2026/april.json",
      connector: stubConnector,
    };
    if (meta.driver === "s3") {
      expect(meta.key).toBe("reports/2026/april.json");
      expect(meta.connector.driver).toBe("http");
    }
  });

  test("http variant carries url + status + bytes_in + required connector", () => {
    const meta: RequestMeta = {
      driver: "http",
      method: "GET",
      url: "https://example.test/v1/items",
      status: 200,
      bytes_in: 1024,
      connector: stubConnector,
    };
    if (meta.driver === "http") {
      expect(meta.url).toBe("https://example.test/v1/items");
    }
  });

  test("graphql variant has its own minimal shape with required connector", () => {
    const meta: RequestMeta = {
      driver: "graphql",
      method: "POST",
      status: 200,
      connector: stubConnector,
    };
    if (meta.driver === "graphql") {
      expect(meta.method).toBe("POST");
    }
  });

  test("connectorless variant covers raw-url HTTP steps (no connector field)", () => {
    const meta: RequestMeta = {
      driver: "connectorless",
      method: "GET",
      url: "https://example.test",
      status: 200,
    };
    if (meta.driver === "connectorless") {
      expect(meta.url).toBe("https://example.test");
    }
  });

  test("error variant carries unresolved_placeholders for pre-dispatch failures", () => {
    const meta: RequestMeta = {
      driver: "error",
      method: "GET",
      url: null,
      unresolved_placeholders: ["${input.x}"],
    };
    if (meta.driver === "error") {
      expect(meta.unresolved_placeholders).toEqual(["${input.x}"]);
    }
  });

  test("extras slot carries engine-internal fields without breaking the discriminator", () => {
    const meta: RequestMeta = {
      driver: "http",
      method: "GET",
      url: "https://x",
      connector: stubConnector,
      extras: { pages_fetched: 3, retries: 1 },
    };
    if (meta.driver === "http") {
      expect(meta.extras?.pages_fetched).toBe(3);
    }
  });

  test("exhaustive switch on driver covers every variant", () => {
    const variants: RequestMeta[] = [
      { driver: "http", method: "GET", url: "u", status: 200, connector: stubConnector },
      { driver: "graphql", method: "POST", status: 200, connector: stubConnector },
      {
        driver: "postgres",
        query_preview: "q",
        row_count: 0,
        transaction: false,
        cursor: false,
        connector: stubConnector,
      },
      { driver: "s3", method: "GET", status: 200, connector: stubConnector },
      { driver: "connectorless", method: "GET", url: null },
      { driver: "error" },
    ];
    let count = 0;
    for (const v of variants) {
      switch (v.driver) {
        case "http":
        case "graphql":
        case "postgres":
        case "s3":
        case "connectorless":
        case "error":
          count++;
          break;
        default: {
          const _exhaustive: never = v;
          throw new Error(`unhandled variant: ${String(_exhaustive)}`);
        }
      }
    }
    expect(count).toBe(6);
  });
});

describe("RequestMetaSchema · OpenAPI parse round-trip", () => {
  test("postgres variant round-trips through Zod parse", () => {
    const meta = {
      driver: "postgres" as const,
      query_preview: "SELECT count(*)",
      row_count: 7,
      transaction: false,
      cursor: false,
      connector: stubConnector,
    };
    const parsed = RequestMetaSchema.parse(meta);
    expect(parsed.driver).toBe("postgres");
  });

  test("missing connector on http variant fails parse", () => {
    const meta = {
      driver: "http",
      method: "GET",
      url: "https://example.test",
    };
    expect(() => RequestMetaSchema.parse(meta)).toThrow();
  });

  test("connectorless does NOT require connector", () => {
    const meta = {
      driver: "connectorless" as const,
      method: "GET",
      url: "https://raw-url",
    };
    expect(() => RequestMetaSchema.parse(meta)).not.toThrow();
  });

  test("unknown driver value rejects (closed enum)", () => {
    const meta = { driver: "made-up", method: "GET" };
    expect(() => RequestMetaSchema.parse(meta)).toThrow();
  });
});
