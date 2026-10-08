import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditAction } from "../../audit/types.ts";
import { _resetLoggerForTests, reconfigureLogger } from "../../logging/logger.ts";
import { type CapturedLog, logRing } from "../../observability/log-ring.ts";
import { makeStubDb, makeTestPrincipal } from "../../tools/tests/_helpers.ts";
import { type ConfirmGateInput, runConfirmGate } from "../confirmation.ts";

const PRINCIPAL = makeTestPrincipal();
const CONVERSATION_ID = "00000000-0000-0000-0000-000000000003";

function gateInput(
  db: ConfirmGateInput["db"],
  overrides: Partial<ConfirmGateInput> = {},
): ConfirmGateInput {
  return {
    tool: "imaginary_tenant_write_tool",
    category: "tenant_write",
    surface: "chat",
    args: { target: "x" },
    db,
    tenant_id: PRINCIPAL.tenant_id,
    principal: PRINCIPAL,
    approval_tool: "imaginary_tenant_write_tool",
    via: "chat",
    record_surface: "web",
    conversation_id: CONVERSATION_ID,
    actor_id: PRINCIPAL.id,
    execution_mode: null,
    precheck: null,
    pause_blocked: false,
    confirmation_kind: "external_write",
    ...overrides,
  };
}

async function gateDecisionLogs(run: () => Promise<unknown>): Promise<CapturedLog[]> {
  const seen: CapturedLog[] = [];
  const unsubscribe = logRing.subscribe((entry) => {
    if (entry.action === "tool_policy.resolved") seen.push(entry);
  });
  try {
    await run();
  } finally {
    unsubscribe();
  }
  return seen;
}

beforeAll(() => {
  reconfigureLogger({ level: "debug" });
});

afterAll(() => {
  _resetLoggerForTests();
});

describe("runConfirmGate — one decision, one side-effect sequence", () => {
  test("a pending elicitation in the turn blocks the pause before any approval row exists", async () => {
    const { db, capture } = makeStubDb();
    const result = await runConfirmGate(gateInput(db, { pause_blocked: true }));
    expect(result.kind).toBe("duplicate_pending");
    expect(capture.inserts).toHaveLength(0);
    expect(result.record).toMatchObject({
      outcome: "duplicate_pending",
      mode: "confirm_before_execution",
      rule: "category_default",
      surface: "web",
      bypassed_confirmation: false,
    });
  });

  test("a refusing precheck answers the model and opens nothing", async () => {
    const { db, capture } = makeStubDb();
    const refusal = { ok: false as const, data: { error: { code: "connector_not_found" } } };
    const result = await runConfirmGate(
      gateInput(db, { precheck: async () => ({ ok: false, result: refusal }) }),
    );
    expect(result).toMatchObject({ kind: "refused", result: refusal });
    expect(result.record.outcome).toBe("refused");
    expect(capture.inserts).toHaveLength(0);
  });

  test("a no_confirm decision proceeds without touching the database", async () => {
    const { db, capture } = makeStubDb();
    const result = await runConfirmGate(
      gateInput(db, { tool: "preview_attachment", category: "tenant_read" }),
    );
    expect(result).toMatchObject({
      kind: "proceed",
      decision: { skip_reason: "mode_not_confirm_before_execution" },
      record: { outcome: "proceed", mode: "no_confirm", rule: "category_default" },
    });
    expect(capture.inserts).toHaveLength(0);
  });

  test("a prior approval proceeds with its own skip reason and opens no second approval", async () => {
    const { db, capture } = makeStubDb();
    const result = await runConfirmGate(gateInput(db, { prior_approval: true }));
    expect(result).toMatchObject({
      kind: "proceed",
      decision: { skip_reason: "prior_approval_present" },
      record: { outcome: "proceed", mode: "confirm_before_execution" },
    });
    expect(capture.inserts).toHaveLength(0);
  });

  test("a confirm with a conversation records confirmation_required, one approval row and APPROVAL_REQUESTED", async () => {
    const { db, capture } = makeStubDb();
    const result = await runConfirmGate(gateInput(db));
    expect(result.kind).toBe("needs_confirm");
    if (result.kind !== "needs_confirm") throw new Error("expected needs_confirm");
    const approvalId = result.approval_id;
    if (approvalId === null) throw new Error("expected an approval id for a known principal");
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.rule).toBe("category_default");
    expect(result.record).toMatchObject({ outcome: "confirm", mode: "confirm_before_execution" });

    const actions = capture.inserts.map((row) => row.action);
    expect(actions.filter((a) => a === AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED)).toHaveLength(
      1,
    );
    expect(actions.filter((a) => a === AuditAction.APPROVAL_REQUESTED)).toHaveLength(1);
    expect(capture.inserts.filter((row) => row.action === undefined)).toHaveLength(1);
    const required = capture.inserts.find(
      (row) => row.action === AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED,
    );
    expect(required?.resource_id).toBe(CONVERSATION_ID);
    const requested = capture.inserts.find((row) => row.action === AuditAction.APPROVAL_REQUESTED);
    expect(requested?.resource_id).toBe(approvalId);
    expect(requested?.resource_type).toBe("conversation_tool_call");
  });

  test("a confirm without a conversation (MCP-direct) emits only APPROVAL_REQUESTED on an mcp_tool_call", async () => {
    const { db, capture } = makeStubDb();
    const result = await runConfirmGate(
      gateInput(db, { surface: "mcp", via: "mcp", record_surface: "mcp", conversation_id: null }),
    );
    expect(result.kind).toBe("needs_confirm");
    const actions = capture.inserts.map((row) => row.action);
    expect(actions).not.toContain(AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED);
    expect(actions.filter((a) => a === AuditAction.APPROVAL_REQUESTED)).toHaveLength(1);
    expect(
      capture.inserts.find((row) => row.action === AuditAction.APPROVAL_REQUESTED),
    ).toMatchObject({ resource_type: "mcp_tool_call" });
    expect(result.record.surface).toBe("mcp");
  });

  test("without a principal the pause is recorded but no approval can be minted", async () => {
    const { db, capture } = makeStubDb();
    const result = await runConfirmGate(gateInput(db, { principal: null }));
    expect(result).toMatchObject({ kind: "needs_confirm", approval_id: null, approval_url: null });
    const actions = capture.inserts.map((row) => row.action);
    expect(actions).toEqual([AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED]);
  });

  test("a failing approval store surfaces as approval_failed after the audit row", async () => {
    const { db, capture } = makeStubDb();
    const broken = {
      ...db,
      transaction: async () => {
        throw new Error("approvals unavailable");
      },
    } as unknown as ConfirmGateInput["db"];
    const result = await runConfirmGate(gateInput(broken));
    expect(result.kind).toBe("approval_failed");
    if (result.kind !== "approval_failed") throw new Error("expected approval_failed");
    expect((result.error as Error).message).toBe("approvals unavailable");
    expect(result.record.outcome).toBe("approval_failed");
    expect(capture.inserts.map((row) => row.action)).toEqual([
      AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED,
    ]);
  });

  test("the precheck effect travels with the pause", async () => {
    const { db } = makeStubDb();
    const effect = { connector: "crm", method: "POST", target: "/contacts" };
    const result = await runConfirmGate(
      gateInput(db, { precheck: async () => ({ ok: true, effect }) }),
    );
    expect(result).toMatchObject({ kind: "needs_confirm", effect });
  });

  test("every outcome is logged exactly once as tool_policy.resolved with rule and mode", async () => {
    const { db } = makeStubDb();
    const runs: Array<[Partial<ConfirmGateInput>, string]> = [
      [{ tool: "preview_attachment", category: "tenant_read" }, "proceed"],
      [{ pause_blocked: true }, "duplicate_pending"],
      [{ precheck: async () => ({ ok: false, result: { ok: false } }) }, "refused"],
      [{}, "confirm"],
      [{ principal: null }, "confirm"],
      [{ tool: "dry_run_workflow", category: "draft_write", surface: "mcp" }, "unavailable"],
    ];
    for (const [overrides, outcome] of runs) {
      const logs = await gateDecisionLogs(() => runConfirmGate(gateInput(db, overrides)));
      expect(logs).toHaveLength(1);
      expect(logs[0]?.fields).toMatchObject({
        tool: "imaginary_tenant_write_tool",
        outcome,
        tenant_id: PRINCIPAL.tenant_id,
        surface: "web",
      });
      expect(typeof logs[0]?.fields.rule).toBe("string");
      expect(typeof logs[0]?.fields.mode).toBe("string");
    }
  });
});
