import { describe, expect, test } from "bun:test";
import { AuditAction, ToolDispatchPolicyDeniedMetadataSchema } from "../../audit/types.ts";
import { runWorkflowTool } from "../../conversations/tools/engine-api/writes/run-workflow.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import { tenants } from "../../db/schema/index.ts";
import { grantApproval, hashToolArgs, requestApproval } from "../approval.ts";
import { dispatchTool } from "../dispatcher.ts";
import { buildRegistry, type ToolProvider } from "../registry.ts";
import type { ToolDescriptor } from "../types.ts";
import {
  approvalAuditRows,
  DB_STUB,
  dbPrincipal,
  nextId,
  PRINCIPAL,
  testDb,
  useDispatcherDb,
} from "./dispatcher-fixtures.ts";

useDispatcherDb();

describe("tools/dispatcher — RBAC denial path", () => {
  test("descriptor.rbac deny → status:'error' error_code:'policy_denied' AND POLICY_DENIED audit row", async () => {
    const captured: Array<{
      action?: string | undefined;
      resource_type?: string | undefined;
      resource_id?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
    }> = [];
    // biome-ignore lint/suspicious/noExplicitAny: stub for tests
    const emptySelectChain: any = {
      from: () => emptySelectChain,
      where: () => emptySelectChain,
      leftJoin: () => emptySelectChain,
      innerJoin: () => emptySelectChain,
      limit: () => Promise.resolve([]),
      orderBy: () => Promise.resolve([]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: stub for tests
    const captureDb: any = {
      transaction: async (fn: (db: unknown) => unknown) => fn(captureDb),
      select: (fields?: { status?: unknown }) =>
        fields?.status === tenants.status
          ? testDb.db.select({ status: tenants.status, deleted_at: tenants.deleted_at })
          : emptySelectChain,
      insert: () => ({
        values: (row: {
          action?: string | undefined;
          resource_type?: string | undefined;
          resource_id?: string | undefined;
          metadata?: Record<string, unknown> | undefined;
        }) => {
          captured.push({
            action: row?.action,
            resource_type: row?.resource_type,
            resource_id: row?.resource_id,
            metadata: row?.metadata,
          });
          return { onConflictDoNothing: async () => undefined };
        },
      }),
    };

    let executed = false;
    const watched: ToolDescriptor = {
      name: "_test_rbac_gated",
      description: "watched",
      category: "tenant_read",
      inputSchema: { type: "object" },
      rbac: {
        permission: "test:perm",
        resource: (args) => ({ type: "test", id: String(args.id ?? "x") }),
      },
    };
    const provider: ToolProvider = {
      name: "GatedProvider",
      list: () => [watched],
      resolve: (n) =>
        n === "_test_rbac_gated"
          ? {
              descriptor: watched,
              executor: {
                kind: "conversation",
                tool: undefined as never,
                execute: async () => {
                  executed = true;
                  return { ok: true, data: {} };
                },
              },
            }
          : undefined,
    };
    const registry = buildRegistry([provider]);
    const envelope = await dispatchTool(
      { registry, db: captureDb, principal: PRINCIPAL, conversationCtx: {} as never },
      { surface: "chat", name: "_test_rbac_gated", args: { id: "abc" } },
    );

    expect(envelope.status).toBe("error");
    if (envelope.status === "error") {
      expect(envelope.error_code).toBe("policy_denied");
    }
    expect(executed).toBe(false);
    const policyDenied = captured.filter((r) => r.action === "policy.denied");
    expect(policyDenied.length).toBe(1);
    expect(policyDenied[0]?.resource_type).toBe("test");
    expect(policyDenied[0]?.resource_id).toBe("abc");
    const metadata = policyDenied[0]?.metadata ?? {};
    expect(metadata.args_hash).toBe(hashToolArgs({ id: "abc" }));
    expect(ToolDispatchPolicyDeniedMetadataSchema.parse(metadata)).toBeTruthy();
  });

  test("RBAC runs BEFORE policy gate — denied tenant_write does NOT emit APPROVAL_REQUESTED", async () => {
    const captured: Array<{ action?: string | undefined }> = [];
    // biome-ignore lint/suspicious/noExplicitAny: stub for tests
    const emptySelectChain: any = {
      from: () => emptySelectChain,
      where: () => emptySelectChain,
      leftJoin: () => emptySelectChain,
      innerJoin: () => emptySelectChain,
      limit: () => Promise.resolve([]),
      orderBy: () => Promise.resolve([]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: stub for tests
    const captureDb: any = {
      transaction: async (fn: (db: unknown) => unknown) => fn(captureDb),
      select: (fields?: { status?: unknown }) =>
        fields?.status === tenants.status
          ? testDb.db.select({ status: tenants.status, deleted_at: tenants.deleted_at })
          : emptySelectChain,
      insert: () => ({
        values: (row: {
          action?: string | undefined;
          resource_type?: string | undefined;
          resource_id?: string | undefined;
        }) => {
          captured.push({ action: row?.action });
          return { onConflictDoNothing: async () => undefined };
        },
      }),
    };

    const watched: ToolDescriptor = {
      name: "_test_writes_rbac",
      description: "watched",
      category: "tenant_write",
      inputSchema: { type: "object" },
      rbac: { permission: "test:perm" },
    };
    const provider: ToolProvider = {
      name: "WatchedWritesProvider",
      list: () => [watched],
      resolve: (n) =>
        n === "_test_writes_rbac"
          ? {
              descriptor: watched,
              executor: {
                kind: "conversation",
                tool: undefined as never,
                execute: async () => ({ ok: true, data: {} }),
              },
            }
          : undefined,
    };
    const registry = buildRegistry([provider]);
    const envelope = await dispatchTool(
      { registry, db: captureDb, principal: PRINCIPAL, conversationCtx: {} as never },
      { surface: "mcp", name: "_test_writes_rbac", args: {} },
    );

    expect(envelope.status).toBe("error");
    expect(captured.filter((r) => r.action === "approval.requested").length).toBe(0);
    expect(captured.filter((r) => r.action === "policy.denied").length).toBe(1);
  });
});

describe("tools/dispatcher — MCP confirmation + APPROVAL_APPROVED lifecycle (real Postgres)", () => {
  function tenantWriteProvider(
    name: string,
    onExecute?: (args: Record<string, unknown>) => void,
  ): ToolProvider {
    const descriptor: ToolDescriptor = {
      name,
      description: "tenant_write, no rbac",
      category: "tenant_write",
      inputSchema: { type: "object" },
    };
    return {
      name: `${name}Provider`,
      list: () => [descriptor],
      resolve: (n) =>
        n === name
          ? {
              descriptor,
              executor: {
                kind: "conversation",
                tool: undefined as never,
                execute: async (_ctx: ToolContext, args: unknown) => {
                  onExecute?.(args as Record<string, unknown>);
                  return { ok: true, data: { ran: true } };
                },
              },
            }
          : undefined,
    };
  }

  test("MCP sk_confirm WITHOUT sk_confirm_id → rejected, not executed, db untouched", async () => {
    let executed = false;
    const registry = buildRegistry([
      tenantWriteProvider("_test_confirm_no_id", () => (executed = true)),
    ]);
    const envelope = await dispatchTool(
      { registry, db: DB_STUB, principal: PRINCIPAL, conversationCtx: {} as never },
      { surface: "mcp", name: "_test_confirm_no_id", args: {}, meta: { sk_confirm: true } },
    );
    expect(envelope.status).toBe("error");
    if (envelope.status === "error") expect(envelope.error_code).toBe("confirmation_missing_id");
    expect(executed).toBe(false);
  });

  test("MCP sk_confirm with an UNKNOWN id (no matching request) → rejected", async () => {
    let executed = false;
    const principal = dbPrincipal();
    const registry = buildRegistry([
      tenantWriteProvider("_test_confirm_unknown", () => (executed = true)),
    ]);
    const envelope = await dispatchTool(
      { registry, db: testDb.db, principal, conversationCtx: {} as never },
      {
        surface: "mcp",
        name: "_test_confirm_unknown",
        args: {},
        meta: { sk_confirm: true, sk_confirm_id: nextId() },
      },
    );
    expect(envelope.status).toBe("error");
    if (envelope.status === "error") expect(envelope.error_code).toBe("unknown_confirmation");
    expect(executed).toBe(false);
  });

  test("MCP sk_confirm with a MATCHING un-consumed request → ok + one APPROVAL_APPROVED sharing the id", async () => {
    let executed = false;
    const principal = dbPrincipal();
    const registry = buildRegistry([
      tenantWriteProvider("_test_confirm_with_id", () => (executed = true)),
    ]);
    const confirmId = nextId();
    await requestApproval({
      db: testDb.db,
      principal,
      approval_id: confirmId,
      tool: "_test_confirm_with_id",
      surface: "mcp",
      via: "mcp",
      reason: "category_default",
      execution_mode: null,
      args: {},
    });
    const granted = await grantApproval({
      db: testDb.db,
      approval_id: confirmId,
      tenant_id: principal.tenant_id,
      granted_by_user_id: principal.id,
      via: "portal",
    });
    expect(granted.ok).toBe(true);
    const envelope = await dispatchTool(
      { registry, db: testDb.db, principal, conversationCtx: {} as never },
      {
        surface: "mcp",
        name: "_test_confirm_with_id",
        args: {},
        meta: { sk_confirm: true, sk_confirm_id: confirmId },
      },
    );
    expect(envelope.status).toBe("ok");
    expect(executed).toBe(true);
    const rows = await approvalAuditRows(confirmId);
    expect(rows.filter((r) => r.action === AuditAction.APPROVAL_APPROVED)).toHaveLength(1);
    expect(rows.every((r) => r.resource_id === confirmId)).toBe(true);
  });

  test("MCP confirm ignores any args sent alongside it — the STORED (granted) args execute", async () => {
    const received: Array<Record<string, unknown>> = [];
    const principal = dbPrincipal();
    const registry = buildRegistry([
      tenantWriteProvider("_test_confirm_args", (args) => received.push(args)),
    ]);
    const confirmId = nextId();
    await requestApproval({
      db: testDb.db,
      principal,
      approval_id: confirmId,
      tool: "_test_confirm_args",
      surface: "mcp",
      via: "mcp",
      reason: "category_default",
      execution_mode: null,
      args: { id: "A" },
    });
    const granted = await grantApproval({
      db: testDb.db,
      approval_id: confirmId,
      tenant_id: principal.tenant_id,
      granted_by_user_id: principal.id,
      via: "portal",
    });
    expect(granted.ok).toBe(true);
    const envelope = await dispatchTool(
      { registry, db: testDb.db, principal, conversationCtx: {} as never },
      {
        surface: "mcp",
        name: "_test_confirm_args",
        args: { id: "B" },
        meta: { sk_confirm: true, sk_confirm_id: confirmId },
      },
    );
    expect(envelope.status).toBe("ok");
    expect(received).toEqual([{ id: "A" }]);
  });

  test("CHAT confirm follows the same stored-args contract as MCP", async () => {
    const received: Array<Record<string, unknown>> = [];
    const principal = dbPrincipal();
    const registry = buildRegistry([
      tenantWriteProvider("_test_confirm_chat", (args) => received.push(args)),
    ]);
    const confirmId = nextId();
    await requestApproval({
      db: testDb.db,
      principal,
      approval_id: confirmId,
      tool: "_test_confirm_chat",
      surface: "chat",
      via: "chat",
      reason: "category_default",
      execution_mode: null,
      args: { id: "A" },
    });
    const granted = await grantApproval({
      db: testDb.db,
      approval_id: confirmId,
      tenant_id: principal.tenant_id,
      granted_by_user_id: principal.id,
      via: "portal",
    });
    expect(granted.ok).toBe(true);
    const envelope = await dispatchTool(
      { registry, db: testDb.db, principal, conversationCtx: {} as never },
      {
        surface: "chat",
        name: "_test_confirm_chat",
        args: { __policy_confirmed: true, __policy_confirm_id: confirmId },
      },
    );
    expect(envelope.status).toBe("ok");
    expect(received).toEqual([{ id: "A" }]);
    const rows = await approvalAuditRows(confirmId);
    expect(rows.filter((r) => r.action === AuditAction.APPROVAL_APPROVED)).toHaveLength(1);
  });
});

describe("tools/dispatcher — run_workflow canonicalization", () => {
  function runWorkflowStub(onExecute: (args: Record<string, unknown>) => void): ToolProvider {
    const descriptor: ToolDescriptor = {
      name: "run_workflow",
      description: "stub using the real run_workflow input schema",
      category: "tenant_write",
      inputSchema: runWorkflowTool.inputSchema,
    };
    return {
      name: "RunWorkflowStubProvider",
      list: () => [descriptor],
      resolve: (n) =>
        n === "run_workflow"
          ? {
              descriptor,
              executor: {
                kind: "conversation",
                tool: undefined as never,
                execute: async (_ctx: ToolContext, args: unknown) => {
                  onExecute(args as Record<string, unknown>);
                  return { ok: true, data: {} };
                },
              },
            }
          : undefined,
    };
  }

  test("input as a JSON STRING vs an OBJECT canonicalize to the SAME args and the SAME execution", async () => {
    const received: Array<Record<string, unknown>> = [];
    const registry = buildRegistry([runWorkflowStub((args) => received.push(args))]);
    const inputObject = { city: "Berlin" };

    const envelope1 = await dispatchTool(
      { registry, db: DB_STUB, principal: PRINCIPAL, conversationCtx: {} as never },
      {
        surface: "chat",
        name: "run_workflow",
        args: { workflow: "invoice-export", environment: "dev", input: inputObject },
      },
    );
    const envelope2 = await dispatchTool(
      { registry, db: DB_STUB, principal: PRINCIPAL, conversationCtx: {} as never },
      {
        surface: "chat",
        name: "run_workflow",
        args: {
          workflow: "invoice-export",
          environment: "dev",
          input: JSON.stringify(inputObject),
        },
      },
    );

    expect(envelope1.status).toBe("ok");
    expect(envelope2.status).toBe("ok");
    expect(received).toHaveLength(2);
    expect(received[0]?.input).toEqual(inputObject);
    expect(received[1]?.input).toEqual(inputObject);
    expect(received[0]).toEqual(received[1]);
  });

  test("run_workflow preserves an omitted environment for schedule-aware execution admission", async () => {
    const received: Array<Record<string, unknown>> = [];
    const registry = buildRegistry([runWorkflowStub((args) => received.push(args))]);
    const envelope = await dispatchTool(
      { registry, db: DB_STUB, principal: PRINCIPAL, conversationCtx: {} as never },
      { surface: "chat", name: "run_workflow", args: { workflow: "invoice-export" } },
    );
    expect(envelope.status).toBe("ok");
    expect(received).toHaveLength(1);
    expect(received[0]?.environment).toBeUndefined();
  });
});
