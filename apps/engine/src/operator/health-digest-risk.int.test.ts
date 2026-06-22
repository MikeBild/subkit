// Integration test: health-digest risk[] is populated when a threshold is crossed.
//
// Drives the live metrics registry + config into a state where one predictive
// threshold is exceeded, then calls buildOperatorHealthDigest() and asserts
// that `risk` is non-empty, `all_clear` is false, and the headline reflects
// the leading-indicator risk.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AuditAction } from "../audit/index.ts";
import { _resetConfigForTests, loadConfig } from "../config/loader.ts";
import { auditLog, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { _resetRssHighWaterForTests, setDlqJobCount } from "../observability/instrumentation.ts";
import { resetMetricsRegistryForTests } from "../observability/metrics.ts";
import { buildOperatorHealthDigest, buildOperatorHealthSummary } from "./health-digest.ts";
import { _resetCriticalEdgeTrackerForTests } from "./risk-signals.ts";

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

describe("buildOperatorHealthDigest — risk[] from metrics", () => {
  test("risk[] is empty when all metrics are below thresholds", async () => {
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();
    _resetCriticalEdgeTrackerForTests();
    const digest = await buildOperatorHealthDigest(testDb.db, tenant_id);
    expect(digest.risk).toEqual([]);
    // With no failures and no risks the digest should be all clear.
    expect(digest.all_clear).toBe(true);
  });

  test("risk[] is populated when a DLQ threshold is crossed", async () => {
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();
    _resetCriticalEdgeTrackerForTests();
    // Default dlq_critical_depth = 5; set DLQ depth to exactly 5 → triggers.
    setDlqJobCount("execution.dlq", 5);

    const digest = await buildOperatorHealthDigest(testDb.db, tenant_id);
    expect(digest.risk.length).toBeGreaterThanOrEqual(1);
    const dlqSignal = digest.risk.find((r) => r.kind === "dlq_growth");
    expect(dlqSignal).toBeDefined();
    expect(dlqSignal!.severity).toBe("critical");
    expect(dlqSignal!.value).toBe(5);
    expect(digest.all_clear).toBe(false);
  });

  test("headline carries the critical risk signal when DLQ is over threshold", async () => {
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();
    _resetCriticalEdgeTrackerForTests();
    setDlqJobCount("execution.dlq", 10);

    const digest = await buildOperatorHealthDigest(testDb.db, tenant_id);
    // The critical signal's headline is prepended to the digest headline.
    expect(digest.headline).toContain("dead-letter");
  });

  test("rendered digest includes the [critical] risk tag when DLQ is over threshold", async () => {
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();
    _resetCriticalEdgeTrackerForTests();
    setDlqJobCount("execution.dlq", 5);

    const digest = await buildOperatorHealthDigest(testDb.db, tenant_id);
    expect(digest.rendered).toContain("[critical]");
  });

  test("wrong tenant sees its own (empty) result — isolation", async () => {
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();
    _resetCriticalEdgeTrackerForTests();
    setDlqJobCount("execution.dlq", 5);

    const [other] = await testDb.db
      .insert(tenants)
      .values({ slug: "t-risk-other", display_name: "Other" })
      .returning();

    // Both tenants share the process-wide metrics registry, so the risk
    // signals fire for both. The isolation contract is at the DB level:
    // failure_groups and patch_candidates are tenant-scoped.
    const digestOther = await buildOperatorHealthDigest(testDb.db, other!.id);
    expect(digestOther.failure_groups).toHaveLength(0);
    expect(digestOther.patch_candidates.pending).toBe(0);
    // Risk signals are process-scoped (shared infrastructure), not tenant-scoped.
    expect(digestOther.risk.length).toBeGreaterThanOrEqual(1);
  });

  // Regression lock for the read-only `audit: false` contract. The summary path
  // (MCP `initialize` instructions, `sk login`) must NEVER write a
  // RISK_SIGNAL_RAISED edge audit or advance the edge tracker — a connect/login
  // is a pure read. If a refactor flips the inverted default, every MCP connect
  // would audit + consume the edge, swallowing the next real one.
  test("buildOperatorHealthSummary writes no risk-signal audit on a critical state", async () => {
    resetMetricsRegistryForTests();
    _resetRssHighWaterForTests();
    _resetCriticalEdgeTrackerForTests();
    setDlqJobCount("execution.dlq", 10); // crosses the critical DLQ edge

    const countRaised = async (): Promise<number> => {
      const rows = await testDb.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, AuditAction.RISK_SIGNAL_RAISED));
      return rows.length;
    };

    // Earlier tests in this file share the same testDb and write RISK_SIGNAL_*
    // rows via the audited digest path; clear them so this case measures only
    // its own writes. Those earlier fire-and-forget writes have long settled
    // (many event-loop turns / awaited tests since), so the delete is clean.
    await testDb.db.delete(auditLog).where(eq(auditLog.action, AuditAction.RISK_SIGNAL_RAISED));

    // Read-only summary: deterministic — `audit: false` skips the whole edge
    // block, so no audit call is even issued (no fire-and-forget race to wait on).
    const summary = await buildOperatorHealthSummary(testDb.db, tenant_id);
    expect(summary.text).toContain("dead-letter");
    expect(await countRaised()).toBe(0);

    // Non-vacuous: the SAME critical state on the audited path DOES raise the
    // edge audit. The write is fire-and-forget; each awaited DB read yields, so
    // a bounded poll (no setTimeout — banned in tests) lets it land.
    await buildOperatorHealthDigest(testDb.db, tenant_id); // audit defaults to true
    let raised = 0;
    for (let i = 0; i < 100 && raised === 0; i++) {
      raised = await countRaised();
    }
    expect(raised).toBeGreaterThanOrEqual(1);
  });
});
