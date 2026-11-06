import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import { toolApprovals } from "../db/schema/index.ts";
import {
  consumeApproval,
  declineApproval,
  grantApproval,
  recordApprovalApproved,
} from "./approval.ts";
import {
  approvalRow,
  auditRowsFor,
  nextId,
  principalIn,
  seedApproval,
  seedGrantedApproval,
  tenant_id,
  testDb,
  useApprovalDb,
} from "./approval-fixtures.ts";

useApprovalDb();

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
