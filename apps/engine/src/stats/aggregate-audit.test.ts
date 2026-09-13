// Integration tests for aggregateAudit — endpoint-axis cardinality cap.
//
// T-C1: Seeds >200 distinct connector.invoked audit rows with distinct
// metadata.path templates for one tenant, calls aggregateAudit with
// includeEndpoint:true, and asserts:
//   - groups are capped at MAX_ENDPOINT_TEMPLATES (200)
//   - truncated_endpoints === true
//   - the kept templates are the highest call-count ones (sort invariant)
//
// Negative case: ≤200 distinct templates → truncated_endpoints is absent.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { auditLog } from "../db/schema/audit.ts";
import { tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { aggregateAudit } from "./aggregate-audit.ts";

const nextUuid = createDeterministicUuidFactory(0xdeadbeef);

let testDb: TestDb;
let tenantId = "";

// Reference "now" anchored to the deterministic clock.
// We use a fixed point in time and insert rows with ts = from + offset.
const REF_MS = getTestNow();
const FROM = new Date(REF_MS - 60 * 60 * 1000); // 1h ago
const TO = new Date(REF_MS + 60 * 1000); // 1 min in the future

beforeAll(async () => {
  testDb = await createTestDb("stats-aggregate-audit");

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "stats-agg-audit", display_name: "Stats Aggregate Audit" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("aggregateAudit — endpoint-axis cardinality cap", () => {
  test("caps groups at 200 and sets truncated_endpoints when >200 distinct path templates", async () => {
    // Seed 210 distinct path templates, each with a different call count
    // (template 0 gets 1 call, template 1 gets 2, …, template 209 gets 210
    // calls). This lets us assert the sort-by-calls invariant: the 200
    // KEPT templates should be the ones with the highest call counts.
    const TOTAL_TEMPLATES = 210;
    const rows: (typeof auditLog.$inferInsert)[] = [];

    const midpoint = new Date(REF_MS - 30 * 60 * 1000); // 30 min ago, inside window

    for (let t = 0; t < TOTAL_TEMPLATES; t++) {
      // Each template gets (t + 1) rows so higher-index templates have more calls.
      for (let c = 0; c < t + 1; c++) {
        rows.push({
          id: nextUuid(),
          ts: midpoint,
          tenant_id: tenantId,
          actor_type: "system",
          actor_id: null,
          action: "connector.invoked",
          resource_type: "connector",
          resource_id: null,
          result: "success",
          // Path template: /api/endpoint-<t>/items so each t maps to a distinct normalized
          // template (no UUIDs or numeric segments to strip, so template is exact).
          metadata: { path: `/api/endpoint-${t}/items` },
        });
      }
    }

    // Insert in batches to avoid hitting parameter limits.
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      await testDb.db.insert(auditLog).values(rows.slice(i, i + BATCH));
    }

    const result = await aggregateAudit(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      actions: ["connector.invoked"],
      groupBy: [],
      includeEndpoint: true,
    });

    // Cap assertion.
    expect(result.groups.length).toBe(200);

    // truncated_endpoints must be set to true.
    expect(result.truncated_endpoints).toBe(true);

    // Sort invariant: the 200 kept groups should be the 200 highest-call-count
    // ones. The seeded data gives template index t a total of (t+1) calls.
    // The top 200 are templates 10..209 (call counts 11..210).
    // Minimum call count among the kept groups must be ≥ 11.
    const minCalls = Math.min(...result.groups.map((g) => g.totals.calls.total));
    expect(minCalls).toBeGreaterThanOrEqual(11);

    // All returned groups must have a non-empty endpoint_path_template key.
    for (const g of result.groups) {
      expect(typeof g.key.endpoint_path_template).toBe("string");
      expect((g.key.endpoint_path_template ?? "").length).toBeGreaterThan(0);
    }
  });

  test("does NOT set truncated_endpoints when ≤200 distinct path templates", async () => {
    // Use a fresh second tenant so this test is fully isolated from the first.
    const [tenant2] = await testDb.db
      .insert(tenants)
      .values({ slug: "stats-agg-audit-small", display_name: "Stats Aggregate Audit Small" })
      .returning();
    if (!tenant2) throw new Error("seed tenant2 failed");
    const tenant2Id = tenant2.id;

    const midpoint = new Date(REF_MS - 30 * 60 * 1000);

    // Seed exactly 5 distinct path templates for the second tenant.
    const smallRows: (typeof auditLog.$inferInsert)[] = [];
    for (let t = 0; t < 5; t++) {
      smallRows.push({
        id: nextUuid(),
        ts: midpoint,
        tenant_id: tenant2Id,
        actor_type: "system",
        actor_id: null,
        action: "connector.invoked",
        resource_type: "connector",
        resource_id: null,
        result: "success",
        metadata: { path: `/api/small-endpoint-${t}/data` },
      });
    }
    await testDb.db.insert(auditLog).values(smallRows);

    const result = await aggregateAudit(testDb.db, {
      tenantId: tenant2Id,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      actions: ["connector.invoked"],
      groupBy: [],
      includeEndpoint: true,
    });

    expect(result.groups.length).toBe(5);
    // truncated_endpoints must be falsy/absent when the cap is not hit.
    expect(result.truncated_endpoints).toBeFalsy();
  });

  test("tenant isolation — results for one tenant do not include rows from another", async () => {
    // Tenant from the first test has 210 paths, but querying with a fresh
    // third tenant should return no groups.
    const [tenant3] = await testDb.db
      .insert(tenants)
      .values({ slug: "stats-agg-audit-iso", display_name: "Stats Aggregate Audit Iso" })
      .returning();
    if (!tenant3) throw new Error("seed tenant3 failed");

    const result = await aggregateAudit(testDb.db, {
      tenantId: tenant3.id,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      actions: ["connector.invoked"],
      groupBy: [],
      includeEndpoint: true,
    });

    expect(result.groups.length).toBe(0);
    expect(result.totals.calls.total).toBe(0);
    expect(result.truncated_endpoints).toBeFalsy();
  });

  test("aggregates legacy egress aliases without classifying successful calls as network errors", async () => {
    const [legacyTenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "stats-agg-audit-legacy", display_name: "Stats Audit Legacy" })
      .returning();
    if (!legacyTenant) throw new Error("seed legacy tenant failed");
    const connectorId = nextUuid();
    await testDb.db.insert(auditLog).values({
      id: nextUuid(),
      ts: new Date(REF_MS - 30 * 60 * 1000),
      tenant_id: legacyTenant.id,
      actor_type: "system",
      actor_id: null,
      action: "connector.invoked",
      resource_type: "connector",
      resource_id: connectorId,
      result: "success",
      metadata: {
        connector_slug: "legacy-egress",
        driver: "http",
        operation: "GET",
        url: "https://api.example.com/v1/items/123e4567-e89b-12d3-a456-426614174000?limit=10",
        status: 200,
        duration_ms: 42,
      },
    });

    const grouped = await aggregateAudit(testDb.db, {
      tenantId: legacyTenant.id,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      actions: ["connector.invoked"],
      groupBy: ["connector_id", "method"],
    });
    expect(grouped.groups[0]?.key).toEqual({ connector_id: connectorId, method: "GET" });
    expect(grouped.totals.calls.by_status_class).toEqual({ "2xx": 1 });
    expect(grouped.totals.latency_ms.total).toBe(42);

    const endpoints = await aggregateAudit(testDb.db, {
      tenantId: legacyTenant.id,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      actions: ["connector.invoked"],
      groupBy: [],
      includeEndpoint: true,
    });
    expect(endpoints.groups[0]?.key.endpoint_path_template).toBe("/v1/items/:id");

    await testDb.db.insert(auditLog).values({
      id: nextUuid(),
      ts: new Date(REF_MS - 29 * 60 * 1000),
      tenant_id: legacyTenant.id,
      actor_type: "system",
      actor_id: null,
      action: "connector.invoked",
      resource_type: "connector",
      resource_id: nextUuid(),
      result: "success",
      metadata: {
        connector_slug: "s3-egress",
        driver: "s3",
        operation: "PUT",
        duration_ms: 7,
      },
    });
    const withNonHttp = await aggregateAudit(testDb.db, {
      tenantId: legacyTenant.id,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      actions: ["connector.invoked"],
      groupBy: [],
    });
    expect(withNonHttp.totals.calls.by_status_class).toEqual({ "2xx": 1, no_status: 1 });
    expect(withNonHttp.totals.latency_ms.total).toBe(49);
  });
});
