import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import type { Executor } from "../../db/client.ts";
import { _withEgressTenantOriginForTests } from "../egress-guard.ts";
import type { ConnectorView } from "../types.ts";
import { closeAllPools, closePoolForConnector, getPoolForConnector } from "./postgres.ts";

const originOverrideExec = {} as Executor;

interface GatedEnd {
  pool: pg.Pool;
  calls: number;
  failure: boolean;
  ending: PromiseWithResolvers<void>;
}

function gateEnd(pool: pg.Pool): GatedEnd {
  const gate: GatedEnd = { pool, calls: 0, failure: false, ending: Promise.withResolvers<void>() };
  const realEnd = pool.end.bind(pool);
  Object.assign(pool, {
    end: () => {
      gate.calls++;
      if (gate.failure) return Promise.reject(new Error("private-connection-failure"));
      return gate.ending.promise.then(() => realEnd());
    },
  });
  return gate;
}

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
        const first = gateEnd(await getPoolForConnector(connector, originOverrideExec));
        const second = gateEnd(
          await getPoolForConnector(
            { ...connector, dsn: "postgres://fixture@127.0.0.1/other" },
            originOverrideExec,
          ),
        );
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
        const reopened = gateEnd(await getPoolForConnector(connector, originOverrideExec));
        expect(reopened.pool).not.toBe(first.pool);
        reopened.ending.resolve();
        await closeAllPools();
        expect(reopened.calls).toBe(1);
        expect(await getPoolForConnector(connector, originOverrideExec)).not.toBe(reopened.pool);
        await closeAllPools();
        const failed = gateEnd(
          await getPoolForConnector({ ...connector, id: "failed-pool" }, originOverrideExec),
        );
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

test("closing one connector does not wait for another connector's pending pool close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subkit-pool-scope-"));
  _resetConfigForTests();
  try {
    await loadConfig({
      env: { DATABASE_URL: "postgres://fixture", NODE_ENV: "test" },
      configPathOverride: join(dir, "config.json"),
    });
    await _withEgressTenantOriginForTests(
      async () => "self_hosted",
      async () => {
        const bystander = {
          id: "pool-bystander",
          tenant_id: "tenant",
          environment: "dev",
          dsn: "postgres://fixture@127.0.0.1/one",
        } as ConnectorView;
        const target = { ...bystander, id: "pool-target" } as ConnectorView;
        const pending = gateEnd(await getPoolForConnector(bystander, originOverrideExec));
        await getPoolForConnector(
          { ...bystander, dsn: "postgres://fixture@127.0.0.1/two" },
          originOverrideExec,
        );
        const closing = gateEnd(await getPoolForConnector(target, originOverrideExec));
        let closed = false;
        const closingTarget = closePoolForConnector(target).then(() => {
          closed = true;
        });
        for (let tick = 0; tick < 10; tick++) await Promise.resolve();
        expect(closed).toBe(false);
        closing.ending.resolve();
        await closingTarget;
        expect(closed).toBe(true);
        expect(closing.calls).toBe(1);
        expect(pending.calls).toBe(1);
        pending.ending.resolve();
        await closePoolForConnector(bystander);
      },
    );
  } finally {
    _resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
