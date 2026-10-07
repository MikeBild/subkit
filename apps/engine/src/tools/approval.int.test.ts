import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { auditLog, tenants, toolApprovals } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import {
  type ApprovalExecutionMode,
  consumeApproval,
  declineApproval,
  grantApproval,
  recordApprovalApproved,
  requestApproval,
} from "./approval.ts";
import { makeTestPrincipal } from "./tests/_helpers.ts";

const nextId = createDeterministicUuidFactory(1);

let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  testDb = await createTestDb("tool-approvals");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-approvals", display_name: "Approvals" })
    .returning();
  tenant_id = tenant!.id;
}, 120_000);

afterAll(async () => {
  await testDb.cleanup();
}, 120_000);

function principalIn(
  tenant: string,
  overrides: Partial<ResolvedPrincipal> = {},
): ResolvedPrincipal {
  return makeTestPrincipal({ tenant_id: tenant, ...overrides });
}

for (const mismatch of ["kind", "product", "missing_origin"] as const) {
  test(`approval ${mismatch} mismatch neither discloses nor consumes the owner's decision`, async () => {
    const owner = principalIn(tenant_id, { product_id: "harmoniqs" });
    const approval_id = nextId();
    await seedGrantedApproval({
      principal: owner,
      approval_id,
      args: { private_canary: "owner-private-approval-args" },
    });
    if (mismatch === "missing_origin")
      await testDb.db
        .update(toolApprovals)
        .set({ caller_context: null })
        .where(eq(toolApprovals.id, approval_id));
    const other =
      mismatch === "kind"
        ? { ...owner, kind: "system_account" as const }
        : mismatch === "product"
          ? { ...owner, product_id: "other" }
          : owner;
    const result = await consumeApproval({
      db: testDb.db,
      principal: other,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(result).toMatchObject({ ok: false, code: "unknown_confirmation" });
    expect(JSON.stringify(result)).not.toContain("owner-private-approval-args");
    expect((await approvalRow(approval_id))?.consumed_at).toBeNull();
    if (mismatch !== "missing_origin") {
      const claimed = await consumeApproval({
        db: testDb.db,
        principal: owner,
        approval_id,
        tool: "run_workflow",
        surface: "mcp",
        via: "mcp",
      });
      expect(claimed).toMatchObject({
        ok: true,
        args: { private_canary: "owner-private-approval-args" },
      });
    }
  });
}

async function auditRowsFor(approval_id: string): Promise<
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

async function approvalRow(approval_id: string) {
  const rows = await testDb.db
    .select()
    .from(toolApprovals)
    .where(eq(toolApprovals.id, approval_id));
  return rows[0] ?? null;
}

async function seedApproval(p: {
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

async function seedGrantedApproval(p: {
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

describe("approval.ts — a freshly minted approval is UNGRANTED", () => {
  test("consumeApproval on an ungranted approval answers approval_not_granted and does NOT burn the handle", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await seedApproval({ principal, approval_id });

    const claim = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("approval_not_granted");

    const row = await approvalRow(approval_id);
    expect(row?.granted_at).toBeNull();
    expect(row?.consumed_at).toBeNull();
    expect(row?.declined_at).toBeNull();

    const granted = await grantApproval({
      db: testDb.db,
      approval_id,
      tenant_id,
      granted_by_user_id: principal.id,
      via: "portal",
    });
    expect(granted.ok).toBe(true);

    const claimed = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(claimed.ok).toBe(true);
  });

  test("a claim against an ungranted approval writes NO audit row — it changed no state", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await seedApproval({ principal, approval_id });

    const before = await auditRowsFor(approval_id);
    expect(before).toHaveLength(1);

    const claim = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(claim.ok).toBe(false);

    const after = await auditRowsFor(approval_id);
    expect(after).toHaveLength(1);
    expect(after[0]?.action).toBe(AuditAction.APPROVAL_REQUESTED);
  });
});

describe("approval.ts — grantApproval single-use", () => {
  test("happy path: grant then consume returns the granted args; a second claim is confirmation_already_used", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    const args = { workflow: "invoice-export", environment: "prod" as const };

    await seedGrantedApproval({ principal, approval_id, execution_mode: "prod", args });

    const first = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("claim should have succeeded");
    expect(first.args).toEqual(args);
    expect(first.execution_mode).toBe("prod");

    const afterClaim = await auditRowsFor(approval_id);
    expect(afterClaim.some((r) => r.action === AuditAction.APPROVAL_APPROVED)).toBe(false);

    expect(
      await recordApprovalApproved({
        db: testDb.db,
        principal,
        claim: first,
        tool: "run_workflow",
        via: "mcp",
      }),
    ).toBe(true);

    const second = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("confirmation_already_used");

    const rows = await auditRowsFor(approval_id);
    const requested = rows.find((r) => r.action === AuditAction.APPROVAL_REQUESTED);
    const grantedRow = rows.find((r) => r.action === AuditAction.APPROVAL_GRANTED);
    const approved = rows.find((r) => r.action === AuditAction.APPROVAL_APPROVED);
    expect(requested?.resource_id).toBe(approval_id);
    expect(grantedRow?.resource_id).toBe(approval_id);
    expect(approved?.resource_id).toBe(approval_id);
    expect(rows.some((r) => r.action === AuditAction.APPROVAL_REJECTED)).toBe(false);
  });

  test("a second grant of an already-granted approval fails", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await seedGrantedApproval({ principal, approval_id });

    const secondGrant = await grantApproval({
      db: testDb.db,
      approval_id,
      tenant_id,
      granted_by_user_id: principal.id,
      via: "portal",
    });
    expect(secondGrant.ok).toBe(false);
    if (!secondGrant.ok) expect(secondGrant.code).toBe("approval_already_granted");

    const claim = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(claim.ok).toBe(true);
  });

  test("grant after expiry fails", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await seedApproval({ principal, approval_id });

    // Force expiry directly — no sleep. // allow-wall-clock
    await testDb.db
      .update(toolApprovals)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(eq(toolApprovals.id, approval_id));

    const granted = await grantApproval({
      db: testDb.db,
      approval_id,
      tenant_id,
      granted_by_user_id: principal.id,
      via: "portal",
    });
    expect(granted.ok).toBe(false);
    if (!granted.ok) expect(granted.code).toBe("approval_expired");

    const claim = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("confirmation_expired");
  });
});

describe("approval.ts — declineApproval is terminal", () => {
  test("decline, then a grant fails, and a claim answers approval_declined — the handle is not burned", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await seedApproval({ principal, approval_id });

    const declined = await declineApproval({
      db: testDb.db,
      approval_id,
      tenant_id,
      granted_by_user_id: principal.id,
      via: "portal",
    });
    expect(declined.ok).toBe(true);

    const grantAfterDecline = await grantApproval({
      db: testDb.db,
      approval_id,
      tenant_id,
      granted_by_user_id: principal.id,
      via: "portal",
    });
    expect(grantAfterDecline.ok).toBe(false);
    if (!grantAfterDecline.ok) expect(grantAfterDecline.code).toBe("approval_already_declined");

    const claim = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.code).toBe("approval_declined");

    const row = await approvalRow(approval_id);
    expect(row?.declined_at).not.toBeNull();
    expect(row?.consumed_at).toBeNull();

    const rows = await auditRowsFor(approval_id);
    expect(rows.map((r) => r.action).sort()).toEqual(
      [
        AuditAction.APPROVAL_REQUESTED,
        AuditAction.APPROVAL_DECLINED,
        AuditAction.APPROVAL_GRANTED,
      ].sort(),
    );
    const deniedGrant = rows.find((r) => r.action === AuditAction.APPROVAL_GRANTED);
    expect(deniedGrant?.reason).toBe("approval_already_declined");
    expect(rows).toHaveLength(3);
  });

  test("a second decline of an already-declined approval fails", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await seedApproval({ principal, approval_id });

    const first = await declineApproval({
      db: testDb.db,
      approval_id,
      tenant_id,
      granted_by_user_id: principal.id,
      via: "portal",
    });
    expect(first.ok).toBe(true);

    const second = await declineApproval({
      db: testDb.db,
      approval_id,
      tenant_id,
      granted_by_user_id: principal.id,
      via: "portal",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("approval_already_declined");
  });
});

describe("approval.ts — grant/decline audit rows record the HUMAN, not the requesting principal", () => {
  test("APPROVAL_GRANTED names the approving human's id, distinct from the requesting principal", async () => {
    const requester = principalIn(tenant_id, { id: nextId() });
    const humanApproverId = nextId();
    expect(humanApproverId).not.toBe(requester.id);

    const approval_id = nextId();
    await seedApproval({ principal: requester, approval_id });

    const granted = await grantApproval({
      db: testDb.db,
      approval_id,
      tenant_id,
      granted_by_user_id: humanApproverId,
      via: "portal",
    });
    expect(granted.ok).toBe(true);

    const rows = await auditRowsFor(approval_id);
    const requestedRow = rows.find((r) => r.action === AuditAction.APPROVAL_REQUESTED);
    const grantedRow = rows.find((r) => r.action === AuditAction.APPROVAL_GRANTED);
    expect(requestedRow?.actor_id).toBe(requester.id);
    expect(grantedRow?.actor_id).toBe(humanApproverId);
    expect(grantedRow?.actor_id).not.toBe(requester.id);
  });

  test("APPROVAL_DECLINED names the declining human's id, distinct from the requesting principal", async () => {
    const requester = principalIn(tenant_id, { id: nextId() });
    const humanApproverId = nextId();
    const approval_id = nextId();
    await seedApproval({ principal: requester, approval_id });

    const declined = await declineApproval({
      db: testDb.db,
      approval_id,
      tenant_id,
      granted_by_user_id: humanApproverId,
      via: "portal",
    });
    expect(declined.ok).toBe(true);

    const rows = await auditRowsFor(approval_id);
    const declinedRow = rows.find((r) => r.action === AuditAction.APPROVAL_DECLINED);
    expect(declinedRow?.actor_id).toBe(humanApproverId);
    expect(declinedRow?.actor_id).not.toBe(requester.id);
  });

  test("an in-band grant relayed by a system account records actor_type=system, not the machine's id as a human", async () => {
    const requester = principalIn(tenant_id, { id: nextId(), kind: "system_account" });
    const approval_id = nextId();
    await seedApproval({ principal: requester, approval_id });

    const granted = await grantApproval({
      db: testDb.db,
      approval_id,
      tenant_id,
      granted_by_user_id: null,
      via: "in_band_elicitation",
    });
    expect(granted.ok).toBe(true);

    const rows = await auditRowsFor(approval_id);
    const grantedRow = rows.find((r) => r.action === AuditAction.APPROVAL_GRANTED);
    expect(grantedRow?.actor_id).toBeNull();
  });
});

describe("approval.ts — the CAS binds (id, tenant_id, principal_id, tool, surface) and the stored execution_mode", () => {
  test("wrong principal_id cannot consume another principal's approval — reads as unknown_confirmation", async () => {
    const owner = principalIn(tenant_id, { id: nextId() });
    const intruder = principalIn(tenant_id, { id: nextId() });
    expect(owner.id).not.toBe(intruder.id);

    const approval_id = nextId();
    await seedGrantedApproval({ principal: owner, approval_id });

    const result = await consumeApproval({
      db: testDb.db,
      principal: intruder,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown_confirmation");

    const ownerClaim = await consumeApproval({
      db: testDb.db,
      principal: owner,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(ownerClaim.ok).toBe(true);
  });

  test("wrong tool name → confirmation_tool_mismatch", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await seedGrantedApproval({ principal, approval_id });

    const result = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "delete_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("confirmation_tool_mismatch");
  });

  test("a chat-minted approval is not claimable over MCP — the CAS binds the surface", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await seedGrantedApproval({ principal, approval_id, surface: "chat" });

    const crossSurface = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(crossSurface.ok).toBe(false);
    if (!crossSurface.ok) expect(crossSurface.code).toBe("confirmation_surface_mismatch");

    const sameSurface = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "chat",
      via: "chat",
    });
    expect(sameSurface.ok).toBe(true);
  });

  test("a dev preview cannot be confirmed into prod — the stored environment wins", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await seedGrantedApproval({ principal, approval_id, tool: "wf_post_ledger_entries" });

    const swapped = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "wf_post_ledger_entries",
      surface: "mcp",
      via: "mcp",
      execution_mode: "prod",
    });
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) expect(swapped.code).toBe("confirmation_environment_mismatch");

    const retry = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "wf_post_ledger_entries",
      surface: "mcp",
      via: "mcp",
      execution_mode: "dev",
    });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.code).toBe("confirmation_already_used");

    const rejections = (await auditRowsFor(approval_id))
      .filter((r) => r.action === AuditAction.APPROVAL_REJECTED)
      .map((r) => r.reason);
    expect(rejections).toContain("confirmation_environment_mismatch");
  });

  test("a confirm that names no environment replays in the stored one", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await seedGrantedApproval({ principal, approval_id, tool: "wf_x", execution_mode: "prod" });

    const claim = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "wf_x",
      surface: "mcp",
      via: "mcp",
    });
    expect(claim.ok).toBe(true);
    if (claim.ok) expect(claim.execution_mode).toBe("prod");
  });

  test("ciphertext tampered at rest is detected → confirmation_integrity_failed, and it is audited", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await seedGrantedApproval({ principal, approval_id });

    const [row] = await testDb.db
      .select({ args_ciphertext: toolApprovals.args_ciphertext })
      .from(toolApprovals)
      .where(eq(toolApprovals.id, approval_id));
    expect(row).toBeDefined();
    const flipped = Buffer.from(row!.args_ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    await testDb.db
      .update(toolApprovals)
      .set({ args_ciphertext: flipped })
      .where(eq(toolApprovals.id, approval_id));

    const result = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("confirmation_integrity_failed");

    const rejected = (await auditRowsFor(approval_id)).find(
      (r) => r.action === AuditAction.APPROVAL_REJECTED,
    );
    expect(rejected?.reason).toBe("confirmation_integrity_failed");

    const after = await approvalRow(approval_id);
    expect(after?.consumed_at).not.toBeNull();
  });

  test("args_hash re-check catches a row whose stored hash no longer matches its plaintext", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await seedGrantedApproval({ principal, approval_id });

    await testDb.db
      .update(toolApprovals)
      .set({ args_hash: "0".repeat(64) })
      .where(eq(toolApprovals.id, approval_id));

    const result = await consumeApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("confirmation_integrity_failed");
  });

  test("APPROVAL_REQUESTED metadata carries canonical_tool + via for cross-surface operator queries", async () => {
    const principal = principalIn(tenant_id);
    const approval_id = nextId();
    await requestApproval({
      db: testDb.db,
      principal,
      approval_id,
      tool: "run_workflow",
      surface: "chat",
      via: "fast_path",
      reason: "tool_default",
      execution_mode: "dev",
      args: { workflow: "x" },
    });

    const [row] = await testDb.db
      .select({ metadata: auditLog.metadata, action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.resource_id, approval_id));
    expect(row?.action).toBe(AuditAction.APPROVAL_REQUESTED);
    const metadata = row?.metadata as Record<string, unknown>;
    expect(metadata.canonical_tool).toBe("run_workflow");
    expect(metadata.via).toBe("fast_path");
    expect(metadata.request_source).toBe("chat");
    expect(metadata.execution_mode).toBe("dev");
    expect(typeof metadata.args_hash).toBe("string");
    expect(metadata.resolver_reason).toBe("tool_default");
  });
});
