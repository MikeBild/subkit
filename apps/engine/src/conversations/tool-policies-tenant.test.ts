// Cross-tenant defense-in-depth coverage for getToolPolicies /
// setToolPolicy. The pre-PR signature took only `(db, conversation_id)`
// and the query filtered by conversation PK alone — a wrong-tenant
// caller with a leaked conversation_id could read or mutate another
// tenant's tool-policy state. The new signature requires `tenant_id`
// and the where-clause anchors on it, so cross-tenant calls return
// `{}` (read) or update zero rows (write).
//
// This file pins the wrong-tenant contract so a future "let me make
// the signature simpler" refactor cannot silently regress it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getToolPolicies, setToolPolicy, type ToolPolicyAuditCtx } from "./tool-policies.ts";

const AUDIT_CTX: ToolPolicyAuditCtx = {
  actor_type: "system",
  actor_id: null,
  request_source: "cli",
};

let testDb: TestDb;
let tenantA: string;
let tenantB: string;
let conversationA: string;

beforeAll(async () => {
  testDb = await createTestDb("tool-policies-tenant");
  const [a] = await testDb.db
    .insert(tenants)
    .values({ slug: "tp-tenant-a", display_name: "Tenant A" })
    .returning();
  const [b] = await testDb.db
    .insert(tenants)
    .values({ slug: "tp-tenant-b", display_name: "Tenant B" })
    .returning();
  if (!a || !b) throw new Error("tenant insert failed");
  tenantA = a.id;
  tenantB = b.id;
  const [convA] = await testDb.db
    .insert(conversations)
    .values({ tenant_id: tenantA, status: "active" })
    .returning();
  if (!convA) throw new Error("conversation insert failed");
  conversationA = convA.id;
  // Seed a real policy on tenant A's conversation so the read-back
  // assertion below has something to differentiate from "row missing".
  await setToolPolicy(testDb.db, tenantA, conversationA, "run_workflow", "no_confirm", AUDIT_CTX);
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("tool-policies cross-tenant isolation", () => {
  test("getToolPolicies under tenant B returns {} for tenant A's conversation", async () => {
    const policies = await getToolPolicies(testDb.db, tenantB, conversationA);
    expect(policies).toEqual({});
    // Sanity: the same call under tenant A still sees the policy
    const same = await getToolPolicies(testDb.db, tenantA, conversationA);
    expect(same.run_workflow).toBe("no_confirm");
  });

  test("setToolPolicy under tenant B does not mutate tenant A's policies", async () => {
    // Hostile call: tenant B tries to set a policy on tenant A's
    // conversation. The where-clause anchors on tenant_id and
    // conversation_id, so the UPDATE matches zero rows.
    await setToolPolicy(
      testDb.db,
      tenantB,
      conversationA,
      "run_workflow",
      "confirm_after_execution",
      AUDIT_CTX,
    );
    const aPolicies = await getToolPolicies(testDb.db, tenantA, conversationA);
    expect(aPolicies.run_workflow).toBe("no_confirm");
  });

  test("setToolPolicy(null) under tenant B does not clear tenant A's policies", async () => {
    // The null-clear path runs the same UPDATE; same isolation
    // contract. Tenant B's null-clear of tenant A's row must not
    // remove tenant A's "no_confirm" override.
    await setToolPolicy(testDb.db, tenantB, conversationA, "run_workflow", null, AUDIT_CTX);
    const aPolicies = await getToolPolicies(testDb.db, tenantA, conversationA);
    expect(aPolicies.run_workflow).toBe("no_confirm");
  });
});
