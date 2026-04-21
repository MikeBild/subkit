// Unit tests for the MCP-layer policy gate.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { gateTenantToolCall } from "../capabilities/policy-gate.ts";

let http: HttpTestServer;

beforeAll(async () => {
  http = await createHttpTestServer("policy-gate");
});

afterAll(async () => {
  await http.cleanup();
});

function mkPrincipal() {
  return {
    id: http.userId,
    tenant_id: http.tenantId,
    kind: "user" as const,
    provider: "api_key" as const,
    email: "admin@test.local",
    role: "admin" as const,
    roles: ["admin"],
    allowed_workflows: "all" as const,
  };
}

describe("gateTenantToolCall", () => {
  it("lets tenant_read tools through without gating", async () => {
    const gate = await gateTenantToolCall({
      tool: "list_workflows",
      category: "tenant_read",
      args: {},
      meta: undefined,
      principal: mkPrincipal(),
      db: http.db,
    });
    expect(gate.kind).toBe("proceed");
  });

  it("returns pending envelope for delete_workflow on first call", async () => {
    const gate = await gateTenantToolCall({
      tool: "delete_workflow",
      category: "tenant_write",
      args: { id: "11111111-1111-1111-1111-111111111111" },
      meta: undefined,
      principal: mkPrincipal(),
      db: http.db,
    });
    expect(gate.kind).toBe("pending");
    if (gate.kind !== "pending") throw new Error("unreachable");
    expect(gate.envelope.pending).toBe(true);
    expect(gate.envelope.confirm_required).toBe(true);
    expect(gate.envelope.policy_mode).toBe("confirm_before_execution");
    expect(gate.envelope.reason).toBe("destructive_action");
    expect(gate.envelope.target.tool).toBe("tenant.delete_workflow");
    expect(gate.envelope.target.args).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
    });
    expect(typeof gate.envelope.tool_call_id).toBe("string");
    expect(gate.envelope.resume).toMatch(/sk_confirm/);

    // APPROVAL_REQUESTED audit row persisted.
    const rows = await http.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, http.tenantId),
          eq(auditLog.action, "approval.requested"),
          eq(auditLog.resource_id, gate.envelope.tool_call_id),
        ),
      );
    expect(rows.length).toBe(1);
  });

  it("proceeds when _meta.sk_confirm is true and writes APPROVAL_APPROVED", async () => {
    const gate = await gateTenantToolCall({
      tool: "delete_workflow",
      category: "tenant_write",
      args: { id: "22222222-2222-2222-2222-222222222222" },
      meta: { sk_confirm: true },
      principal: mkPrincipal(),
      db: http.db,
    });
    expect(gate.kind).toBe("proceed");
    const rows = await http.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, http.tenantId), inArray(auditLog.action, ["approval.approved"])),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("honours __policy_confirmed: true as an args-level alias", async () => {
    const gate = await gateTenantToolCall({
      tool: "delete_workflow",
      category: "tenant_write",
      args: { id: "33333333-3333-3333-3333-333333333333", __policy_confirmed: true },
      meta: undefined,
      principal: mkPrincipal(),
      db: http.db,
    });
    expect(gate.kind).toBe("proceed");
  });

  it("skips gating for non-destructive tenant_write tools (propose_step is draft, but run_workflow in dev is no_confirm)", async () => {
    const gate = await gateTenantToolCall({
      tool: "run_workflow",
      category: "tenant_write",
      args: { environment: "dev" },
      meta: undefined,
      principal: mkPrincipal(),
      db: http.db,
    });
    expect(gate.kind).toBe("proceed");
  });

  it("gates run_workflow in prod (dynamic computeModeFromInput escalation)", async () => {
    const gate = await gateTenantToolCall({
      tool: "run_workflow",
      category: "tenant_write",
      args: { environment: "prod" },
      meta: undefined,
      principal: mkPrincipal(),
      db: http.db,
    });
    expect(gate.kind).toBe("pending");
  });
});
