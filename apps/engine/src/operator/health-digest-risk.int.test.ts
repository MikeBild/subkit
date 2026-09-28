// Integration test: risk signals in the digest, the attention list, and the
// audit edges the scheduler — not a reader — records for them.
//
// Drives the live metrics registry + config into a state where one predictive
// threshold is exceeded, then asserts that the digest carries the signal, the
// attention list turns a CRITICAL one into an item, and that reading any of it
// writes no audit row while the scheduler tick does.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { _drainAuditWritesForTests, AuditAction } from "../audit/index.ts";
import { SYSTEM_TENANT_ID } from "../audit/types.ts";
import { _resetConfigForTests, loadConfig } from "../config/loader.ts";
import { auditLog, riskSignalEdges, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { _resetRssHighWaterForTests, setDlqJobCount } from "../observability/instrumentation.ts";
import { resetMetricsRegistryForTests } from "../observability/metrics.ts";
import { runRiskSignalEdges } from "../scheduler/risk-signal-edges-runner.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import { buildAttention, invalidateAttention } from "./attention.ts";
import { buildOperatorHealthDigest, buildOperatorHealthSummary } from "./health-digest.ts";
import { invalidateOperationalOverview } from "./operational-overview.ts";
import { _resetRiskSignalEdgesForTests, type RiskSignal, takeRiskEdges } from "./risk-signals.ts";

let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  testDb = await createTestDb("operator-risk");

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-risk-digest", display_name: "Risk Digest" })
    .returning();
  tenant_id = tenant!.id;

  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-risk-digest-"));
  await loadConfig({
    env: { DATABASE_URL: testDb.url, NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
});

afterAll(async () => {
  _resetConfigForTests();
  await testDb.cleanup();
});

beforeEach(async () => {
  resetMetricsRegistryForTests();
  _resetRssHighWaterForTests();
  await _resetRiskSignalEdgesForTests(testDb.db);
  // The attention list caches tenant facts for 10 s; each case changes the
  // process metrics under it.
  invalidateAttention();
  invalidateOperationalOverview();
});

const RISK_ACTIONS = [AuditAction.RISK_SIGNAL_RAISED, AuditAction.RISK_SIGNAL_CLEARED];

async function clearRiskAudits(): Promise<void> {
  await _drainAuditWritesForTests(testDb.db);
  await testDb.db.delete(auditLog).where(inArray(auditLog.action, RISK_ACTIONS));
}

async function riskAudits(): Promise<number> {
  // Drain first: a fire-and-forget write still in flight must count.
  await _drainAuditWritesForTests(testDb.db);
  const rows = await testDb.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(inArray(auditLog.action, RISK_ACTIONS));
  return rows.length;
}

describe("buildOperatorHealthDigest — risk[] from metrics", () => {
  test("risk[] is empty when all metrics are below thresholds", async () => {
    const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id));
    expect(digest.risk).toEqual([]);
    expect(digest.attention.items).toEqual([]);
    expect(digest.all_clear).toBe(true);
  });

  test("a critical DLQ signal is in risk[] and is one attention item", async () => {
    // Default dlq_critical_depth = 5; set DLQ depth to exactly 5 → triggers.
    setDlqJobCount("execution.dlq", 5);

    const digest = await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id));
    const dlqSignal = digest.risk.find((r) => r.kind === "dlq_growth");
    expect(dlqSignal?.severity).toBe("critical");
    expect(dlqSignal?.value).toBe(5);
    const item = digest.attention.items.find((i) => i.id === "risk:dlq_growth");
    expect(item?.class).toBe("failing");
    expect(item?.severity).toBe("critical");
    expect(item?.detail).toContain("dead-letter");
    expect(digest.all_clear).toBe(false);
    expect(digest.headline).toBe("Needs attention: 1 item (1 failing).");
    expect(digest.rendered).toContain("[critical]");
  });

  test("risk signals are host-scoped; every tenant's list names them", async () => {
    setDlqJobCount("execution.dlq", 5);
    const [other] = await testDb.db
      .insert(tenants)
      .values({ slug: "t-risk-other", display_name: "Other" })
      .returning();
    const digestOther = await buildOperatorHealthDigest(testDb.db, adminPrincipal(other!.id));
    expect(digestOther.failure_groups).toHaveLength(0);
    expect(digestOther.patch_candidates.open).toBe(0);
    expect(digestOther.attention.items.map((i) => i.id)).toEqual(["risk:dlq_growth"]);
  });
});

describe("risk-signal audit edges belong to the scheduler, not to a reader", () => {
  test("reading the digest, the MCP summary and the attention list writes no audit row", async () => {
    setDlqJobCount("execution.dlq", 10); // crosses the critical DLQ edge
    await clearRiskAudits();

    const summary = await buildOperatorHealthSummary(testDb.db, adminPrincipal(tenant_id));
    expect(summary.text).toContain("dead-letter");
    await buildOperatorHealthDigest(testDb.db, adminPrincipal(tenant_id));
    await buildAttention(testDb.db, adminPrincipal(tenant_id));
    expect(await riskAudits()).toBe(0);
    expect(await testDb.db.select().from(riskSignalEdges)).toEqual([]);

    // Positive control: the same critical state IS recorded — by the tick,
    // once, with no read in between.
    const edges = await runRiskSignalEdges(testDb.db, { instance: "a" });
    expect(edges.raised).toContain("dlq_growth");
    const rows = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, AuditAction.RISK_SIGNAL_RAISED),
          eq(auditLog.tenant_id, SYSTEM_TENANT_ID),
          eq(auditLog.resource_id, "dlq_growth"),
        ),
      );
    expect(rows).toHaveLength(1);
    const metadata = (rows[0]?.metadata ?? {}) as { request_source?: string };
    expect(metadata.request_source).toBe("scheduler");
    expect((await runRiskSignalEdges(testDb.db, { instance: "a" })).raised).toEqual([]);
    expect(await riskAudits()).toBe(1);
  });

  test("the tick records a raise once, and the clear when the signal recovers", async () => {
    await clearRiskAudits();
    setDlqJobCount("execution.dlq", 10);
    expect((await runRiskSignalEdges(testDb.db, { instance: "a" })).raised).toEqual(["dlq_growth"]);
    // A standing critical is not raised again on the next tick.
    expect((await runRiskSignalEdges(testDb.db, { instance: "a" })).raised).toEqual([]);
    setDlqJobCount("execution.dlq", 0);
    expect((await runRiskSignalEdges(testDb.db, { instance: "a" })).cleared).toEqual([
      "dlq_growth",
    ]);
    expect(await riskAudits()).toBe(2);
  });

  test("an audit write that fails leaves the edge unclaimed; the next tick records it once", async () => {
    await clearRiskAudits();
    setDlqJobCount("execution.dlq", 10);
    await testDb.db.execute(sql`
      CREATE OR REPLACE FUNCTION fail_risk_audit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'audit insert refused'; END $$ LANGUAGE plpgsql`);
    await testDb.db.execute(sql`
      CREATE TRIGGER fail_risk_audit BEFORE INSERT ON audit_log FOR EACH ROW
      WHEN (NEW.action = 'operator.risk_signal_raised') EXECUTE FUNCTION fail_risk_audit()`);
    try {
      await expect(runRiskSignalEdges(testDb.db, { instance: "a" })).rejects.toThrow();
    } finally {
      await testDb.db.execute(sql`DROP TRIGGER fail_risk_audit ON audit_log`);
    }
    expect(await riskAudits()).toBe(0);

    expect((await runRiskSignalEdges(testDb.db, { instance: "a" })).raised).toEqual(["dlq_growth"]);
    expect((await runRiskSignalEdges(testDb.db, { instance: "a" })).raised).toEqual([]);
    expect(await riskAudits()).toBe(1);
  });

  test("two ticks at once record one edge", async () => {
    await clearRiskAudits();
    setDlqJobCount("execution.dlq", 10);
    const [first, second] = await Promise.all([
      runRiskSignalEdges(testDb.db, { instance: "a" }),
      runRiskSignalEdges(testDb.db, { instance: "b" }),
    ]);
    expect([...first.raised, ...second.raised]).toEqual(["dlq_growth"]);
    expect(await riskAudits()).toBe(1);
  });
});

// Cross-caller edge dedup through the shared table.
describe("takeRiskEdges — whose edge it is", () => {
  const signal = (kind: string): RiskSignal => ({
    kind,
    severity: "critical",
    headline: "x",
    detail: "x",
    metric: "m",
    value: 10,
    threshold: 5,
  });

  test("a shared signal raises once across callers; recovers; re-fires", async () => {
    const dlq = signal("dlq_growth");
    const first = await takeRiskEdges(testDb.db, [dlq], "a");
    expect(first.raised.map((s) => s.kind)).toEqual(["dlq_growth"]);
    const second = await takeRiskEdges(testDb.db, [dlq], "b");
    expect(second.raised).toEqual([]);
    expect(second.cleared).toEqual([]);

    const recover = await takeRiskEdges(testDb.db, [], "b");
    expect(recover.cleared).toEqual(["dlq_growth"]);
    expect((await takeRiskEdges(testDb.db, [], "a")).cleared).toEqual([]);

    const again = await takeRiskEdges(testDb.db, [dlq], "a");
    expect(again.raised.map((s) => s.kind)).toEqual(["dlq_growth"]);
  });

  test("a process-local signal is each process's own edge — no flapping between processes", async () => {
    const pool = signal("pool_saturation");
    // Process a is saturated, process b is not.
    expect((await takeRiskEdges(testDb.db, [pool], "a")).raised.map((s) => s.kind)).toEqual([
      "pool_saturation",
    ]);
    // b's healthy pass must not clear a's edge…
    expect((await takeRiskEdges(testDb.db, [], "b")).cleared).toEqual([]);
    // …so a's next pass does not raise it again.
    expect((await takeRiskEdges(testDb.db, [pool], "a")).raised).toEqual([]);
    // b saturating is its own, separate edge.
    expect((await takeRiskEdges(testDb.db, [pool], "b")).raised.map((s) => s.kind)).toEqual([
      "pool_saturation",
    ]);
    // a recovering clears a's edge only.
    expect((await takeRiskEdges(testDb.db, [], "a")).cleared).toEqual(["pool_saturation"]);
    expect((await takeRiskEdges(testDb.db, [pool], "b")).raised).toEqual([]);
  });
});
