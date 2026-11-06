import { expect, mock, test } from "bun:test";

const pools: FakePool[] = [];
class FakePool {
  failure = false;
  ending = Promise.withResolvers<void>();
  calls = 0;
  constructor() {
    pools.push(this);
  }
  on() {
    return this;
  }
  end() {
    this.calls++;
    return this.failure
      ? Promise.reject(new Error("private-connection-failure"))
      : this.ending.promise;
  }
}
mock.module("pg", () => ({ default: { Pool: FakePool } }));
const { _withEgressTenantOriginForTests } = await import("../egress-guard.ts");
const { getPoolForConnector, closePoolForConnector, closeAllPools } = await import("./postgres.ts");
const { _resetConfigForTests, loadConfig } = await import("../../config/loader.ts");
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

import type { Executor } from "../../db/client.ts";
import type { ConnectorView } from "../types.ts";

const originOverrideExec = {} as Executor;

test("active and retired pools retain real close promises and failed closes block global drain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subkit-pool-shutdown-"));
  _resetConfigForTests();
  try {
    await loadConfig({
      env: { DATABASE_URL: "postgres://fixture", NODE_ENV: "test" },
      configPathOverride: join(dir, "config.json"),
    });
    await _withEgressTenantOriginForTests(
      async () => "self_hosted",
      async () => {
        const connector = {
          id: "pool-drain",
          tenant_id: "tenant",
          environment: "dev",
          dsn: "postgres://fixture@127.0.0.1/test",
        } as ConnectorView;
        await getPoolForConnector(connector, originOverrideExec);
        const first = pools[0];
        if (!first) throw new Error("pool_fixture_missing");
        await getPoolForConnector(
          { ...connector, dsn: "postgres://fixture@127.0.0.1/other" },
          originOverrideExec,
        );
        const second = pools[1];
        if (!second) throw new Error("pool_fixture_missing");
        let drained = false;
        const closing = closePoolForConnector(connector).then(() => {
          drained = true;
        });
        await Promise.resolve();
        expect(first.calls).toBe(1);
        expect(second.calls).toBe(1);
        expect(drained).toBe(false);
        first.ending.resolve();
        await Promise.resolve();
        expect(drained).toBe(false);
        second.ending.resolve();
        await closing;
        expect(drained).toBe(true);
        await closeAllPools();
        await getPoolForConnector({ ...connector, id: "failed-pool" }, originOverrideExec);
        const failed = pools[2];
        if (!failed) throw new Error("pool_fixture_missing");
        failed.failure = true;
        await expect(closeAllPools()).rejects.toThrow("connector_pool_close_failed");
        expect(failed.calls).toBe(1);
        await expect(closeAllPools()).rejects.toThrow("connector_pool_close_failed");
        expect(failed.calls).toBe(1);
      },
    );
  } finally {
    _resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
