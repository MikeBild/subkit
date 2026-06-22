// Integration: the `list_audit` tool, driven through a real tenant-scoped
// EngineClient against a per-test database, must honour its `action` filter.
//
// Regression context: the tool used to set `filters.action` (singular) +
// `as any`, so `audit/query.ts`'s `inArray(action, filters.actions)` never
// fired and the query returned EVERY tenant row regardless of `action`.
// This test seeds two rows with distinct actions in ONE tenant, filters by
// one action, and asserts exactly that row comes back — proving the filter
// reaches `inArray` end to end.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditAction } from "../../../audit/types.ts";
import { auditLog } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { queryAuditTool } from "../generated/audit.ts";
import type { ToolContext } from "../index.ts";

// Deterministic fixtures (no randomUUID — the determinism gate forbids it).
const tenant_id = "11111111-1111-4111-8111-111111111111";
const ROW_A_ID = "22222222-2222-4222-8222-222222222222";
const ROW_B_ID = "33333333-3333-4333-8333-333333333333";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb("list_audit_action_filter");

  // Two rows, same tenant, distinct actions.
  await testDb.db.insert(auditLog).values([
    {
      id: ROW_A_ID,
      tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.CONNECTOR_INVOKED,
      resource_type: "connector",
      resource_id: "conn-a",
      result: "success",
    },
    {
      id: ROW_B_ID,
      tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.CREDENTIAL_ROTATED,
      resource_type: "credential",
      resource_id: "cred-b",
      result: "success",
    },
  ]);
});

afterAll(async () => {
  await testDb.cleanup();
});

function makeCtx(): ToolContext {
  const engineClient = new EngineClient({ tenant_id, actor_id: null, db: testDb.db });
  return { engineClient } as unknown as ToolContext;
}

describe("list_audit action filter (integration)", () => {
  test("returns only rows matching the requested action", async () => {
    const res = await queryAuditTool.execute(makeCtx(), {
      action: AuditAction.CONNECTOR_INVOKED,
    });

    expect(res.ok).toBe(true);
    const entries = (res.data as { entries: Array<{ action: string; resource_id: string | null }> })
      .entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe(AuditAction.CONNECTOR_INVOKED);
    expect(entries[0]?.resource_id).toBe("conn-a");
  });

  test("without an action filter, both tenant rows return", async () => {
    const res = await queryAuditTool.execute(makeCtx(), {});

    expect(res.ok).toBe(true);
    const entries = (res.data as { entries: unknown[] }).entries;
    expect(entries).toHaveLength(2);
  });
});
