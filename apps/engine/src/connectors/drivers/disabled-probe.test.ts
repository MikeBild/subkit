import { describe, expect, test } from "bun:test";
import type { Db } from "../../db/client.ts";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import type { ConnectorView, DriverName } from "../types.ts";
import { probeConnector } from "./index.ts";

const forbiddenDb = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`a refused probe touched the database: ${String(prop)}`);
    },
  },
) as unknown as Db;

const TENANT_ID = "00000000-0000-0000-0000-0000000000aa";

function disabledConnector(driver: DriverName): ConnectorView {
  return {
    id: "00000000-0000-0000-0000-0000000000d1",
    tenant_id: TENANT_ID,
    slug: `disabled-${driver}`,
    display_name: `disabled ${driver}`,
    driver,
    environment: "dev",
    auth_type: "none",
    base_url: "https://probe.invalid/",
    dsn: "postgres://nobody@240.0.0.1:1/nodb",
    config: driver === "mcp" ? { mcp: { transport: "http" } } : {},
    operator_quirks: {},
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    self_description: {},
    created_at: new Date(0),
    updated_at: new Date(0),
    enabled: false,
    last_error: null,
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_failure_count: 0,
    circuit_threshold: 5,
    circuit_reset_ms: 300_000,
    needs_reauth: false,
    auth_failed_at: null,
    auth_failed_reason: null,
    health_state: "ok",
    health_reason: null,
    health_error_code: null,
    sunset_at: null,
    successor_uri: null,
  };
}

let fetchCalls = 0;

async function countingEgress<T>(body: () => Promise<T>): Promise<T> {
  fetchCalls = 0;
  return withDriverFetchForTests(
    ((...args: Parameters<typeof fetch>) => {
      fetchCalls++;
      return Promise.reject(
        new Error(`unexpected driver egress to ${String(args[0])} from a disabled connector`),
      );
    }) as typeof fetch,
    body,
  );
}

const DRIVERS: DriverName[] = ["http", "graphql", "postgres", "s3", "mcp"];

describe("probeConnector refuses a disabled connector on every driver", () => {
  for (const driver of DRIVERS) {
    test(`${driver}: refused with connector_disabled, no wire and no database`, async () => {
      const result = await countingEgress(() =>
        probeConnector({
          db: forbiddenDb,
          tenant_id: TENANT_ID,
          connector: disabledConnector(driver),
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.error_code).toBe("connector_disabled");
      expect(result.detail).toContain("disabled");
      expect(result.latency_ms).toBe(0);
      expect(fetchCalls).toBe(0);
    });
  }

  test("the refusal survives a credential override — a supplied secret is not a bypass", async () => {
    const result = await probeConnector({
      db: forbiddenDb,
      tenant_id: TENANT_ID,
      connector: disabledConnector("http"),
      credential_override: { mode: "bearer", token: "unused" },
    });
    expect(result.error_code).toBe("connector_disabled");
    expect(fetchCalls).toBe(0);
  });

  test("an enabled connector is still dispatched to its driver", async () => {
    const result = await probeConnector({
      db: forbiddenDb,
      tenant_id: TENANT_ID,
      connector: { ...disabledConnector("postgres"), dsn: null, enabled: true },
    });
    expect(result.ok).toBe(false);
    expect(result.error_code).not.toBe("connector_disabled");
  });
});
