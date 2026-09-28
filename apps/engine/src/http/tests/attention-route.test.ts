// GET /v1/attention — one truth on three surfaces, and a pure read.
//
// The MCP connect line, the endpoint and the digest's decision block used to be
// three renderings of three predicates. They now render one list: the same
// items, the same count, for the same reader.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { _drainAuditWritesForTests } from "../../audit/index.ts";
import { auditLog, patchCandidates, workflowsSchedules } from "../../db/schema/index.ts";
import type { AttentionV1 } from "../../operator/attention.ts";
import { invalidateAttention } from "../../operator/attention.ts";
import {
  buildOperatorHealthSummary,
  type OperatorHealthDigest,
} from "../../operator/health-digest.ts";
import { invalidateOperationalOverview } from "../../operator/operational-overview.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { reviewableDiff, seedPatchableWorkflow } from "../../test-helpers/patch-candidates.ts";
import { adminPrincipal } from "../../test-helpers/principals.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("attention_route");
  const held = await seedPatchableWorkflow(srv.db, srv.tenantId, "held", "Held");
  const patched = await seedPatchableWorkflow(srv.db, srv.tenantId, "patched", "Patched");
  await srv.db.insert(workflowsSchedules).values({
    tenant_id: srv.tenantId,
    workflow_id: held.workflow_id,
    cron: "0 * * * *",
    admission_hold: {
      reason_code: "execution_authority_required",
      observed_at: new Date(getTestNow()).toISOString(),
    },
  });
  await srv.db.insert(patchCandidates).values(
    ["a", "b"].map((d) => ({
      tenant_id: srv.tenantId,
      workflow_id: patched.workflow_id,
      classification: "safe" as const,
      status: "proposed" as const,
      diff: reviewableDiff(d),
    })),
  );
});

afterAll(async () => {
  await srv.cleanup();
});

beforeEach(() => {
  invalidateAttention();
  invalidateOperationalOverview();
});

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${srv.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function auditRows(): Promise<number> {
  await _drainAuditWritesForTests(srv.db);
  return (await srv.db.select({ id: auditLog.id }).from(auditLog)).length;
}

test("the endpoint returns attention.v1 for the caller", async () => {
  const body = await get<AttentionV1>("/v1/attention");
  expect(body.schema_version).toBe("attention.v1");
  expect(body.items.map((i) => [i.class, i.kind])).toEqual([
    ["stopped", "workflow"],
    ["decide", "workflow"],
  ]);
  expect(body.items[1]?.counts.patches).toBe(2);
  expect(body.status?.health_state).toBe("critical");
});

test("reading it writes no audit row", async () => {
  const before = await auditRows();
  await get<AttentionV1>("/v1/attention");
  await get<AttentionV1>("/v1/attention");
  expect(await auditRows()).toBe(before);
});

test("MCP connect line, endpoint and digest block count the same items", async () => {
  const endpoint = await get<AttentionV1>("/v1/attention");
  const digest = await get<OperatorHealthDigest>("/v1/operator/health-digest");
  // The API key belongs to the seeded admin user: the same reader.
  const summary = await buildOperatorHealthSummary(
    srv.db,
    adminPrincipal(srv.tenantId, srv.userId),
  );

  const ids = endpoint.items.map((i) => i.id);
  expect(digest.attention.items.map((i) => i.id)).toEqual(ids);
  expect(summary.attention.items.map((i) => i.id)).toEqual(ids);

  const itemLine = /^- \[(stopped|failing|decide)\]/;
  const summaryLines = summary.text.split("\n").filter((line) => itemLine.test(line));
  const digestLines = digest.rendered.split("\n").filter((line) => itemLine.test(line));
  expect(summaryLines.length).toBe(ids.length);
  expect(digestLines).toEqual(summaryLines);
  expect(summary.text.split("\n")[0]).toBe(digest.headline);
  expect(digest.headline).toBe(`Needs attention: ${ids.length} items (1 stopped, 1 to decide).`);
});
