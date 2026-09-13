// "Disabled" means disabled on every driver.
//
// `probeConnector` refuses a connector whose operator switch is off before
// it dispatches to a driver, so nothing leaves the tenant. These tests
// prove the refusal is universal rather than per-driver, and that it costs
// no I/O at all.
//
// WHY `connector_disabled` IS THE PROOF: no driver body can produce that
// code — the http, graphql, postgres and s3 probes have no notion of the
// flag, and the mcp probe only learns it from a pool handshake that the
// registry short-circuits. Observing it therefore means the driver never
// ran. The fetch counter and the throwing `Db` are the second and third
// witnesses: a probe that reached any driver would touch one of them.

import { describe, expect, test } from "bun:test";

import type { Db } from "../../db/client.ts";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import type { ConnectorView, DriverName } from "../types.ts";
import { probeConnector } from "./index.ts";

/** Any property read is a database round-trip a refused probe must not make. */
const forbiddenDb = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`a refused probe touched the database: ${String(prop)}`);
    },
  },
) as unknown as Db;

const TENANT_ID = "00000000-0000-0000-0000-0000000000aa";

/**
 * A definition pointed at a host that would fail loudly if contacted, so a
 * regression cannot pass by quietly succeeding against something reachable.
 */
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
    // Port 1 on the discard address: a real connect attempt is refused,
    // which is a different outcome from the one these tests assert.
    dsn: "postgres://nobody@240.0.0.1:1/nodb",
    config: driver === "mcp" ? { mcp: { transport: "http" } } : {},
    operator_quirks: {},
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    self_description: {},
    // Fixed instants: the fixture only needs these columns to be dates, and
    // a wall-clock read makes the suite non-reproducible for no benefit.
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

// The counting fetch is bound to the DRIVER EGRESS SEAM, not to globalThis.
// Bun shares one process across concurrently-running test files, so a
// globalThis.fetch stub leaks into every sibling suite for as long as it is
// installed — the exact cross-file interference this repo has spent real time
// chasing elsewhere. `withDriverFetchForTests` scopes the override to what is
// awaited inside its body and to nothing else.
let fetchCalls = 0;

/** Run `body` with driver egress counted, and assert nothing reached the wire. */
async function countingEgress<T>(body: () => Promise<T>): Promise<T> {
  fetchCalls = 0;
  return withDriverFetchForTests(
    ((...args: Parameters<typeof fetch>) => {
      fetchCalls++;
      // A probe that gets this far has already failed the test; answering with a
      // rejection keeps a real socket out of it either way.
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
      // Not `unknown_upstream_error`: nothing upstream was contacted, and a
      // reader who branches on that code investigates a healthy remote.
      expect(result.detail).toContain("disabled");
      // Nothing was attempted, so there is no elapsed time to report.
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
    // The guard must refuse the disabled case only. A postgres connector with
    // no dsn proves dispatch happened without needing a socket: `credential_missing`
    // is the driver's own verdict, which the registry short-circuit cannot produce.
    const result = await probeConnector({
      db: forbiddenDb,
      tenant_id: TENANT_ID,
      connector: { ...disabledConnector("postgres"), dsn: null, enabled: true },
    });
    expect(result.ok).toBe(false);
    expect(result.error_code).not.toBe("connector_disabled");
  });
});
