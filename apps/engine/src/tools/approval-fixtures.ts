import { afterAll, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { auditLog, toolApprovals } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { type ApprovalExecutionMode, grantApproval, requestApproval } from "./approval.ts";
import { makeTestPrincipal } from "./tests/_helpers.ts";

export const nextId = createDeterministicUuidFactory(1);

export let testDb: TestDb;

export let tenant_id: string;

export function principalIn(
  tenant: string,
  overrides: Partial<ResolvedPrincipal> = {},
): ResolvedPrincipal {
  return makeTestPrincipal({ tenant_id: tenant, ...overrides });
}

export async function auditRowsFor(approval_id: string): Promise<
  Array<{
    action: string;
    resource_id: string | null;
    actor_id: string | null;
    reason: string | null;
  }>
> {
  return testDb.db
    .select({
      action: auditLog.action,
      resource_id: auditLog.resource_id,
      actor_id: auditLog.actor_id,
      reason: auditLog.reason,
    })
    .from(auditLog)
    .where(eq(auditLog.resource_id, approval_id));
}

export async function approvalRow(approval_id: string) {
  const rows = await testDb.db
    .select()
    .from(toolApprovals)
    .where(eq(toolApprovals.id, approval_id));
  return rows[0] ?? null;
}

export async function seedApproval(p: {
  principal: ResolvedPrincipal;
  approval_id: string;
  tool?: string;
  surface?: "mcp" | "chat";
  execution_mode?: ApprovalExecutionMode | null;
  args?: Record<string, unknown>;
}): Promise<void> {
  await requestApproval({
    db: testDb.db,
    principal: p.principal,
    approval_id: p.approval_id,
    tool: p.tool ?? "run_workflow",
    surface: p.surface ?? "mcp",
    via: p.surface === "chat" ? "chat" : "mcp",
    reason: "held_writes",
    execution_mode: p.execution_mode ?? "dev",
    args: p.args ?? { workflow: "x" },
  });
}

export async function seedGrantedApproval(p: {
  principal: ResolvedPrincipal;
  approval_id: string;
  tool?: string;
  surface?: "mcp" | "chat";
  execution_mode?: ApprovalExecutionMode | null;
  args?: Record<string, unknown>;
  granted_by_user_id?: string;
}): Promise<void> {
  await seedApproval(p);
  const granted = await grantApproval({
    db: testDb.db,
    approval_id: p.approval_id,
    tenant_id: p.principal.tenant_id,
    granted_by_user_id: p.granted_by_user_id ?? p.principal.id,
    via: "portal",
  });
  if (!granted.ok) throw new Error(`seed grant failed: ${granted.code}`);
}

export function useApprovalDb(): void {
  beforeAll(async () => {
    testDb = await createTestDb("tool-approvals");
    const tenant = await seedTenant(testDb.db, { slug: "t-approvals", display_name: "Approvals" });
    tenant_id = tenant.id;
  }, 120_000);
  afterAll(async () => {
    await testDb.cleanup();
  }, 120_000);
}
