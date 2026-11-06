import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditAwait } from "../../audit/audit.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { getMetrics, METRIC_NAMES, resetMetricsRegistryForTests } from "../metrics.ts";

let testDb: TestDb;
let tenantId = "";

beforeAll(async () => {
  testDb = await createTestDb("audit-metrics");
  tenantId = (await seedTenant(testDb.db, { slug: "audit-metrics", display_name: "Audit Metrics" }))
    .id;
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
    expect(counterValue("workflow.created", "success")).toBe(0);

    await auditAwait(
      {
        tenant_id: tenantId,
        action: "workflow.created",
        resource_type: "workflow",
        resource_id: crypto.randomUUID(), // allow-random: legacy; review before changing
        result: "success",
      },
      testDb.db,
    );
    await auditAwait(
      {
        tenant_id: tenantId,
        action: "workflow.created",
        resource_type: "workflow",
        resource_id: crypto.randomUUID(), // allow-random: legacy; review before changing
        result: "success",
      },
      testDb.db,
    );

    expect(counterValue("workflow.created", "success")).toBe(2);

    await auditAwait(
      {
        tenant_id: tenantId,
        action: "policy.denied",
        resource_type: "workflow",
        resource_id: crypto.randomUUID(), // allow-random: legacy; review before changing
        result: "denied",
        reason: "permission_denied:test",
      },
      testDb.db,
    );
    expect(counterValue("policy.denied", "denied")).toBe(1);
  });
});
