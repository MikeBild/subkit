import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, conversations, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import {
  getToolPolicies,
  setToolPolicies,
  setToolPolicy,
  type ToolPolicyAuditCtx,
} from "./tool-policies.ts";

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
  await setToolPolicy(
    testDb.db,
    tenantA,
    conversationA,
    "save_workflow_draft",
    "no_confirm",
    AUDIT_CTX,
  );
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("tool-policies cross-tenant isolation", () => {
  test("getToolPolicies under tenant B returns {} for tenant A's conversation", async () => {
    const policies = await getToolPolicies(testDb.db, tenantB, conversationA);
    expect(policies).toEqual({});
    const same = await getToolPolicies(testDb.db, tenantA, conversationA);
    expect(same.save_workflow_draft).toBe("no_confirm");
  });

  test("setToolPolicy under tenant B does not mutate tenant A's policies", async () => {
    await setToolPolicy(
      testDb.db,
      tenantB,
      conversationA,
      "save_workflow_draft",
      "confirm_before_execution",
      AUDIT_CTX,
    );
    const aPolicies = await getToolPolicies(testDb.db, tenantA, conversationA);
    expect(aPolicies.save_workflow_draft).toBe("no_confirm");
  });

  test("setToolPolicy(null) under tenant B does not clear tenant A's policies", async () => {
    await setToolPolicy(testDb.db, tenantB, conversationA, "save_workflow_draft", null, AUDIT_CTX);
    const aPolicies = await getToolPolicies(testDb.db, tenantA, conversationA);
    expect(aPolicies.save_workflow_draft).toBe("no_confirm");
  });

  test("rejects unsafe writes without a partial policy or audit mutation", async () => {
    const [conversation] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: tenantA, status: "active" })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");

    await expect(
      setToolPolicies(
        testDb.db,
        tenantA,
        conversation.id,
        {
          save_workflow_draft: "no_confirm",
          call_connector: "no_confirm",
        },
        AUDIT_CTX,
      ),
    ).rejects.toThrow("tool_policy_mode_not_allowed:call_connector");

    expect(await getToolPolicies(testDb.db, tenantA, conversation.id)).toEqual({});
    const audits = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resource_id, conversation.id));
    expect(audits).toHaveLength(0);
  });

  test("filters persisted legacy unsafe overrides", async () => {
    const [conversation] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: tenantA,
        status: "active",
        tool_policies: {
          call_connector: "no_confirm",
          save_workflow_draft: "no_confirm",
          run_workflow: "confirm_after_execution",
        },
      })
      .returning();
    if (!conversation) throw new Error("conversation insert failed");

    expect(await getToolPolicies(testDb.db, tenantA, conversation.id)).toEqual({
      save_workflow_draft: "no_confirm",
    });
  });
});
