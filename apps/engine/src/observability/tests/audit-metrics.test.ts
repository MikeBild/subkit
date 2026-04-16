// Audit writer bumps the `audit_rows_written_total` counter.
//
// The counter is labelled `{action, result}` — we want operators to
// be able to read off the action mix and deny-rate directly from
// Prometheus without joining back against the audit_log table. This
// test drives the writer through its real persistence path (a
// disposable Postgres database) so the metric write only fires if the
// INSERT actually succeeds.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditAwait } from "../../audit/audit.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getMetrics, METRIC_NAMES, resetMetricsRegistryForTests } from "../metrics.ts";

let testDb: TestDb;
let tenantId = "";

beforeAll(async () => {
  testDb = await createTestDb("audit-metrics");
  const [row] = await testDb.db
    .insert(tenants)
    .values({ slug: "audit-metrics", display_name: "Audit Metrics" })
    .returning();
  if (!row) throw new Error("seed tenant failed");
  tenantId = row.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

function counterValue(action: string, result: string): number {
  const snap = getMetrics().snapshot();
  const series = snap.find((s) => s.name === METRIC_NAMES.AUDIT_ROWS_WRITTEN_TOTAL);
  if (!series) return 0;
  const sample = series.samples.find(
    (s) => s.labels.action === action && s.labels.result === result,
  );
  return sample?.value ?? 0;
}

describe("audit_rows_written_total counter", () => {
  test("bumps by 2 after two successful audit() calls", async () => {
    resetMetricsRegistryForTests();
    // Sanity — we start from zero.
    expect(counterValue("workflow.created", "success")).toBe(0);

    await auditAwait(
      {
        tenant_id: tenantId,
        action: "workflow.created",
        resource_type: "workflow",
        resource_id: crypto.randomUUID(),
        result: "success",
      },
      testDb.db,
    );
    await auditAwait(
      {
        tenant_id: tenantId,
        action: "workflow.created",
        resource_type: "workflow",
        resource_id: crypto.randomUUID(),
        result: "success",
      },
      testDb.db,
    );

    expect(counterValue("workflow.created", "success")).toBe(2);

    // A denied row lands on a distinct label set so the two samples
    // don't collide.
    await auditAwait(
      {
        tenant_id: tenantId,
        action: "policy.denied",
        resource_type: "workflow",
        resource_id: crypto.randomUUID(),
        result: "denied",
        reason: "permission_denied:test",
      },
      testDb.db,
    );
    expect(counterValue("policy.denied", "denied")).toBe(1);
  });
});
