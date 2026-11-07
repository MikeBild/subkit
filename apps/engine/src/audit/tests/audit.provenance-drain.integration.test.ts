import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { withContext } from "../../logging/context.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { flush, waitFor } from "../../test-helpers/determinism/wait.ts";
import { _drainAuditWritesForTests, audit, auditAwait } from "../audit.ts";
import { tenantA, tenantB, testDb, useAuditContractsDb } from "./contracts-fixtures.ts";

useAuditContractsDb();

const uuid = createDeterministicUuidFactory(0xa0d18);

async function rowsFor(resourceId: string) {
  return testDb.db.select().from(auditLog).where(eq(auditLog.resource_id, resourceId));
}

async function holdAuditTableLock(): Promise<{ release: () => Promise<void> }> {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let signalLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const holder = testDb.db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE audit_log IN SHARE MODE`);
    signalLocked();
    await gate;
  });
  await locked;
  return {
    release: async () => {
      releaseGate();
      await holder;
    },
  };
}

async function insertIsWaitingOnLock(): Promise<boolean> {
  const res = await testDb.db.execute(
    sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'insert into "audit_log"%'`,
  );
  const rows = (res as unknown as { rows: Array<{ n: number }> }).rows;
  return (rows[0]?.n ?? 0) > 0;
}

async function stillPendingOnceInsertBlocks(p: Promise<void>): Promise<boolean> {
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  await waitFor(insertIsWaitingOnLock, { label: "audit insert blocked", sleepMs: 10 });
  await flush();
  await flush();
  return !settled;
}

describe("provenance from the request context", () => {
  test("a non-UUID api key id from the context is stored only redacted", async () => {
    const resourceId = uuid();
    await withContext({ tenant_id: tenantA, api_key_id: "key_plain_text" }, () =>
      auditAwait({ action: "tenant.created", resource_id: resourceId }, testDb.db),
    );
    const metadata = (await rowsFor(resourceId))[0]?.metadata as Record<string, unknown>;
    expect(typeof metadata.api_key_id).toBe("string");
    expect(metadata.api_key_id).not.toBe("key_plain_text");
    expect(metadata.audit_used_api_key_id).toBeUndefined();
  });

  test("an entry written without any context provenance carries no provenance keys at all", async () => {
    const resourceId = uuid();
    const filled = await withContext({ tenant_id: tenantA }, () =>
      auditAwait(
        { action: "tenant.created", resource_id: resourceId, metadata: { kept: 1 } },
        testDb.db,
      ),
    );
    expect(Object.keys(filled.metadata)).toEqual(["kept"]);
    expect((await rowsFor(resourceId))[0]?.metadata).toEqual({ kept: 1 });
  });

  test("context provenance stamped on one tenant's row does not appear on another tenant's row", async () => {
    const stamped = uuid();
    const plain = uuid();
    await withContext(
      { tenant_id: tenantA, audit_access_type: "mcp_oauth", audit_oauth_client_id: "client-a" },
      () => auditAwait({ action: "tenant.created", resource_id: stamped }, testDb.db),
    );
    await withContext({ tenant_id: tenantB }, () =>
      auditAwait({ action: "tenant.created", resource_id: plain }, testDb.db),
    );
    expect((await rowsFor(stamped))[0]).toMatchObject({
      tenant_id: tenantA,
      metadata: { audit_access_type: "mcp_oauth", audit_oauth_client_id: "client-a" },
    });
    expect((await rowsFor(plain))[0]).toMatchObject({ tenant_id: tenantB, metadata: {} });
  });
});

describe("draining fire-and-forget writes", () => {
  test("a drain for the write's executor waits until the blocked write lands", async () => {
    const resourceId = uuid();
    const lock = await holdAuditTableLock();
    let drain: Promise<void> = Promise.resolve();
    try {
      audit({ tenant_id: tenantA, action: "tenant.created", resource_id: resourceId }, testDb.db);
      drain = _drainAuditWritesForTests(testDb.db);
      expect(await stillPendingOnceInsertBlocks(drain)).toBe(true);
    } finally {
      await lock.release();
    }
    await drain;
    expect(await rowsFor(resourceId)).toHaveLength(1);
  });

  test("a drain without an executor waits for writes bound to any executor", async () => {
    const resourceId = uuid();
    const lock = await holdAuditTableLock();
    let drain: Promise<void> = Promise.resolve();
    try {
      audit({ tenant_id: tenantA, action: "tenant.created", resource_id: resourceId }, testDb.db);
      drain = _drainAuditWritesForTests();
      expect(await stillPendingOnceInsertBlocks(drain)).toBe(true);
    } finally {
      await lock.release();
    }
    await drain;
    expect(await rowsFor(resourceId)).toHaveLength(1);
  });
});
