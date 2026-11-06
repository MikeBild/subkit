import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import { auditLog, toolApprovals } from "../db/schema/index.ts";
import { consumeApproval, declineApproval, grantApproval, requestApproval } from "./approval.ts";
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
