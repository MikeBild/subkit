import { afterAll, beforeAll, expect, test } from "bun:test";
import { AuditAction } from "../audit/types.ts";
import { auditLog } from "../db/schema/audit.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { connectorObservations } from "./observations.ts";

const nextId = createDeterministicUuidFactory(0xc0b5e);
const tenantId = nextId();
const otherTenant = nextId();
const connectorId = nextId();
const unknownId = nextId();
let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("connector_observations");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function observation(
  action: string,
  metadata: Record<string, unknown>,
  offset: number,
  tenant = tenantId,
  result = "success",
) {
  await ctx.db.insert(auditLog).values({
    id: nextId(),
    ts: new Date(FROZEN_NOW + offset),
    tenant_id: tenant,
    actor_type: "system",
    actor_id: null,
    action,
    resource_type: "connector",
    resource_id: connectorId,
    result,
    metadata,
  });
}

test("uses the latest explicit probe and manifest evidence with tenant isolation", async () => {
  await observation(AuditAction.CONNECTOR_INVOKED, { method: "PROBE" }, 0);
  await observation(AuditAction.CONNECTOR_INVOKED, { method: "PROBE" }, 1, tenantId, "error");
  await observation(AuditAction.CONNECTOR_INVOKED, { method: "GET" }, 2);
  await observation(AuditAction.CONNECTOR_INVOKED, { method: "PROBE" }, 3, otherTenant);
  await observation(AuditAction.CONNECTOR_MCP_HANDSHAKE_OK, { tool_count: 5 }, 0);
  await observation(AuditAction.CONNECTOR_MCP_MANIFEST_DRIFT, { observed_tool_count: 0 }, 1);
  await observation(AuditAction.CONNECTOR_MCP_HANDSHAKE_OK, { tool_count: 100 }, 2, otherTenant);
  const rows = await connectorObservations(ctx.db, tenantId, [connectorId, unknownId]);
  expect(rows.get(connectorId)).toEqual({
    last_tested_at: new Date(FROZEN_NOW + 1).toISOString(),
    tools_count: 0,
  });
  expect(rows.has(unknownId)).toBe(false);
  expect(await connectorObservations(ctx.db, tenantId, [])).toEqual(new Map());
  await observation(AuditAction.CONNECTOR_MCP_HANDSHAKE_OK, { tool_count: "20" }, 4);
  expect(
    (await connectorObservations(ctx.db, tenantId, [connectorId])).get(connectorId)?.tools_count,
  ).toBeNull();
});
