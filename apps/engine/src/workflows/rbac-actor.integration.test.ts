import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { gateWorkflowRunRbac } from "./rbac.ts";

const nextUuid = createDeterministicUuidFactory(0x7134);
let ctx: TestDb;
let tenantId: string;

beforeAll(async () => {
  ctx = await createTestDb("workflow_rbac_actor");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "workflow-rbac-actor", display_name: "Workflow RBAC Actor" })
    .returning({ id: tenants.id });
  if (!tenant) throw new Error("test tenant missing");
  tenantId = tenant.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

test("workflow run denial audit preserves a system account actor", async () => {
  const accountId = nextUuid();
  const workflowId = nextUuid();
  const decision = await gateWorkflowRunRbac({
    db: ctx.db,
    principal: {
      provider: "test",
      kind: "system_account",
      id: accountId,
      tenant_id: tenantId,
      roles: [],
    },
    workflow_id: workflowId,
    request_source: "mcp",
  });
  expect(decision.allow).toBe(false);
  const [audit] = await ctx.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenantId),
        eq(auditLog.action, "policy.denied"),
        eq(auditLog.resource_id, workflowId),
      ),
    )
    .limit(1);
  expect(audit).toEqual({ actor_type: "system_account", actor_id: accountId });
});

test("workflow run denial audit preserves portal user kind without persisting an opaque ID", async () => {
  const workflowId = nextUuid();
  const decision = await gateWorkflowRunRbac({
    db: ctx.db,
    principal: {
      provider: "portal_token",
      kind: "user",
      id: "external-crm-contact-42",
      tenant_id: tenantId,
      roles: ["enduser"],
      allowed_workflows: [],
    },
    workflow_id: workflowId,
    request_source: "mcp",
  });
  expect(decision.allow).toBe(false);
  const [audit] = await ctx.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenantId),
        eq(auditLog.action, "policy.denied"),
        eq(auditLog.resource_id, workflowId),
      ),
    )
    .limit(1);
  expect(audit).toEqual({ actor_type: "user", actor_id: null });
});
