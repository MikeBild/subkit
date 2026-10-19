import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AuditAction, ToolDispatchPolicyDeniedMetadataSchema } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { runWorkflowTool } from "../../conversations/tools/engine-api/writes/run-workflow.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import { auditLog, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { envelopeToMcpResponse } from "../../mcp/adapter.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { grantApproval, hashToolArgs, requestApproval } from "../approval.ts";
import { dispatchTool } from "../dispatcher.ts";
import { conversationToolProvider, staticToolProvider } from "../index.ts";
import {
  DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON,
  DRAFT_WRITE_MCP_UNAVAILABLE_REASON,
} from "../policy.ts";
import { buildRegistry, type ToolProvider } from "../registry.ts";
import type { ToolDescriptor, ToolEnvelope } from "../types.ts";

const PRINCIPAL: ResolvedPrincipal = {
  provider: "test",
  kind: "user",
  id: "00000000-0000-4000-8000-000000000001",
  tenant_id: "00000000-0000-4000-8000-000000000002",
  authoring_role_id: null,
  scopes: new Set(),
  permission_grants: [],
  role_ids: [],
  api_key_id: null,
  // biome-ignore lint/suspicious/noExplicitAny: stub for tests
} as any;

// biome-ignore lint/suspicious/noExplicitAny: drizzle chain shape
const UPDATE_STUB: any = {
  set: () => UPDATE_STUB,
  where: () => UPDATE_STUB,
  returning: () => Promise.resolve([]),
};
// biome-ignore lint/suspicious/noExplicitAny: drizzle Db shape
const DB_STUB: any = {
  transaction: async (fn: (db: unknown) => unknown) => fn(DB_STUB),
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
  update: () => UPDATE_STUB,
};

const nextId = createDeterministicUuidFactory(2);

let testDb: TestDb;
let dbTenantId: string;

beforeAll(async () => {
  testDb = await createTestDb("dispatcher-confirm");
  DB_STUB.select = testDb.db.select.bind(testDb.db);
  await testDb.db.insert(tenants).values({
    id: PRINCIPAL.tenant_id,
    slug: "dispatcher-policy-fixture",
    display_name: "Dispatcher Policy",
  });
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-dispatcher-confirm", display_name: "Dispatcher Confirm" })
    .returning();
  dbTenantId = tenant!.id;
}, 120_000);

afterAll(async () => {
  await testDb.cleanup();
}, 120_000);

function dbPrincipal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the PRINCIPAL stub above
  return { ...(PRINCIPAL as any), tenant_id: dbTenantId, ...overrides } as ResolvedPrincipal;
}

async function approvalAuditRows(
  approval_id: string,
): Promise<Array<{ action: string; resource_id: string | null; metadata: unknown }>> {
  return testDb.db
    .select({
      action: auditLog.action,
      resource_id: auditLog.resource_id,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(eq(auditLog.resource_id, approval_id));
}

describe("tools/dispatcher (active)", () => {
  test("unknown tool name → status:'error' error_code:'tool_not_found'", async () => {
    const registry = buildRegistry([staticToolProvider, conversationToolProvider]);
    const envelope = await dispatchTool(
      { registry, db: DB_STUB, principal: PRINCIPAL },
      { surface: "chat", name: "definitely_not_a_real_tool", args: {} },
    );
    expect(envelope.status).toBe("error");
    if (envelope.status === "error") {
      expect(envelope.error_code).toBe("tool_not_found");
    }
  });

  test("draft_write on MCP → status:'not_available_on_surface'", async () => {
    const registry = buildRegistry([staticToolProvider, conversationToolProvider]);
    const envelope = await dispatchTool(
      { registry, db: DB_STUB, principal: PRINCIPAL, mcpMode: "authoring" },
      { surface: "mcp", name: "save_workflow_draft", args: {} },
    );
    expect(envelope.status).toBe("not_available_on_surface");
    if (envelope.status === "not_available_on_surface") {
      expect(envelope.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);
    }
  });

  test("MCP tenant_write waits for a local human approval before invoking the executor", async () => {
    let executed = false;
    const watchedDescriptor: ToolDescriptor = {
      name: "_test_mcp_write_proceeds",
      description: "watched",
      category: "tenant_write",
      inputSchema: { type: "object" },
    };
    const watchedProvider: ToolProvider = {
      name: "McpProceedsProvider",
      list: () => [watchedDescriptor],
      resolve: (n) =>
        n === "_test_mcp_write_proceeds"
          ? {
              descriptor: watchedDescriptor,
              executor: {
                kind: "conversation",
                tool: undefined as never,
                execute: async () => {
                  executed = true;
                  return { ok: true, data: { ran: true } };
                },
              },
            }
          : undefined,
    };
    const registry = buildRegistry([watchedProvider]);
    const envelope = await dispatchTool(
      { registry, db: testDb.db, principal: dbPrincipal(), conversationCtx: {} as never },
      { surface: "mcp", name: "_test_mcp_write_proceeds", args: {} },
    );
    expect(envelope.status).toBe("needs_confirm");
    if (envelope.status === "needs_confirm") {
      const rows = await approvalAuditRows(envelope.confirm.tool_call_id);
      expect(rows.filter((row) => row.action === AuditAction.APPROVAL_REQUESTED)).toHaveLength(1);
      expect(rows.filter((row) => row.action === AuditAction.APPROVAL_APPROVED)).toHaveLength(0);
    }
    expect(executed).toBe(false);
  });

  test("needs_confirm path → returns envelope without invoking executor", async () => {
    let executed = false;
    const watchedDescriptor: ToolDescriptor = {
      name: "_test_tenant_write",
      description: "watched",
      category: "tenant_write",
      inputSchema: { type: "object" },
    };
    const watchedProvider: ToolProvider = {
      name: "WatchedProvider",
      list: () => [watchedDescriptor],
      resolve: (n) =>
        n === "_test_tenant_write"
          ? {
              descriptor: watchedDescriptor,
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
    const registry = buildRegistry([watchedProvider]);
    const envelope = await dispatchTool(
      { registry, db: DB_STUB, principal: PRINCIPAL },
      { surface: "chat", name: "_test_tenant_write", args: {} },
    );
    expect(envelope.status).toBe("needs_confirm");
    expect(executed).toBe(false);
  });

  test("needs_confirm + sk_confirm meta → proceeds to executor", async () => {
    let executed = false;
    const watchedDescriptor: ToolDescriptor = {
      name: "_test_confirmed_write",
      description: "watched",
      category: "tenant_write",
      inputSchema: { type: "object" },
    };
    const watchedProvider: ToolProvider = {
      name: "ConfirmedProvider",
      list: () => [watchedDescriptor],
      resolve: (n) =>
        n === "_test_confirmed_write"
          ? {
              descriptor: watchedDescriptor,
              executor: {
                kind: "conversation",
                tool: undefined as never,
                execute: async () => {
                  executed = true;
                  return { ok: true, data: { ran: true } };
                },
              },
            }
          : undefined,
    };
    const registry = buildRegistry([watchedProvider]);
    const principal = dbPrincipal();
    const confirmId = nextId();
    await requestApproval({
      db: testDb.db,
      principal,
      approval_id: confirmId,
      tool: "_test_confirmed_write",
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
      {
        registry,
        db: testDb.db,
        principal,
        conversationCtx: {} as never,
      },
      {
        surface: "mcp",
        name: "_test_confirmed_write",
        args: {},
        meta: { sk_confirm: true, sk_confirm_id: confirmId },
      },
    );
    expect(envelope.status).toBe("ok");
    if (envelope.status === "ok") {
      expect(envelope.data).toEqual({ ran: true });
    }
    expect(executed).toBe(true);
    const rows = await approvalAuditRows(confirmId);
    expect(rows.filter((r) => r.action === AuditAction.APPROVAL_APPROVED)).toHaveLength(1);
  });

  test("executor throwing → status:'error' error_code:'tool_execute_failed'", async () => {
    const watchedDescriptor: ToolDescriptor = {
      name: "_test_throws",
      description: "throws",
      category: "tenant_read",
      inputSchema: { type: "object" },
    };
    const watchedProvider: ToolProvider = {
      name: "ThrowsProvider",
      list: () => [watchedDescriptor],
      resolve: (n) =>
        n === "_test_throws"
          ? {
              descriptor: watchedDescriptor,
              executor: {
                kind: "conversation",
                tool: undefined as never,
                execute: async () => {
                  throw new Error("boom");
                },
              },
            }
          : undefined,
    };
    const registry = buildRegistry([watchedProvider]);
    const envelope = await dispatchTool(
      {
        registry,
        db: DB_STUB,
        principal: PRINCIPAL,
        conversationCtx: {} as never,
      },
      { surface: "chat", name: "_test_throws", args: {} },
    );
    expect(envelope.status).toBe("error");
    if (envelope.status === "error") {
      expect(envelope.error_code).toBe("tool_execute_failed");
      expect(envelope.message).toContain("boom");
    }
  });

  test("envelope is normalized: ok=true ToolResult → status:'ok' envelope", async () => {
    const watchedDescriptor: ToolDescriptor = {
      name: "_test_ok",
      description: "ok",
      category: "tenant_read",
      inputSchema: { type: "object" },
    };
    const watchedProvider: ToolProvider = {
      name: "OkProvider",
      list: () => [watchedDescriptor],
      resolve: (n) =>
        n === "_test_ok"
          ? {
              descriptor: watchedDescriptor,
              executor: {
                kind: "conversation",
                tool: undefined as never,
                execute: async () => ({ ok: true, data: { hello: "world" } }),
              },
            }
          : undefined,
    };
    const registry = buildRegistry([watchedProvider]);
    const envelope = await dispatchTool(
      {
        registry,
        db: DB_STUB,
        principal: PRINCIPAL,
        conversationCtx: {} as never,
      },
      { surface: "chat", name: "_test_ok", args: {} },
    );
    const e: ToolEnvelope = envelope;
    expect(e.status).toBe("ok");
    if (e.status === "ok") {
      expect(e.data).toEqual({ hello: "world" });
    }
  });

  test("envelope is normalized: ok=false ToolResult → status:'error' with error_code", async () => {
    const watchedDescriptor: ToolDescriptor = {
      name: "_test_err",
      description: "err",
      category: "tenant_read",
      inputSchema: { type: "object" },
    };
    const watchedProvider: ToolProvider = {
      name: "ErrProvider",
      list: () => [watchedDescriptor],
      resolve: (n) =>
        n === "_test_err"
          ? {
              descriptor: watchedDescriptor,
              executor: {
                kind: "conversation",
                tool: undefined as never,
                execute: async () => ({
                  ok: false,
                  error_code: "thing_missing",
                  message: "no thing",
                  next_best_actions: ["create_thing"],
                }),
              },
            }
          : undefined,
    };
    const registry = buildRegistry([watchedProvider]);
    const envelope = await dispatchTool(
      {
        registry,
        db: DB_STUB,
        principal: PRINCIPAL,
        conversationCtx: {} as never,
      },
      { surface: "chat", name: "_test_err", args: {} },
    );
    expect(envelope.status).toBe("error");
    if (envelope.status === "error") {
      expect(envelope.error_code).toBe("thing_missing");
      expect(envelope.message).toBe("no thing");
      expect(envelope.next_best_actions).toEqual(["create_thing"]);
    }
  });

  test("a refusal that names its code in its payload reaches MCP with that code on top", async () => {
    const descriptor: ToolDescriptor = {
      name: "_test_legacy_refusal",
      description: "legacy refusal",
      category: "tenant_read",
      inputSchema: { type: "object" },
    };
    let payload: Record<string, unknown> = {};
    const provider: ToolProvider = {
      name: "LegacyRefusalProvider",
      list: () => [descriptor],
      resolve: (n) =>
        n === descriptor.name
          ? {
              descriptor,
              executor: {
                kind: "conversation",
                tool: undefined as never,
                execute: async () => ({ ok: false, data: payload }),
              },
            }
          : undefined,
    };
    const registry = buildRegistry([provider]);
    const overMcp = async () =>
      envelopeToMcpResponse(
        await dispatchTool(
          { registry, db: DB_STUB, principal: PRINCIPAL, buildMcpStubCtx: () => ({}) as never },
          { surface: "mcp", name: descriptor.name, args: {} },
        ),
      );

    payload = {
      error_code: "workflow_activation_required",
      message: "The saved change needs human review.",
      review_url: "https://engine.example.test/cockpit/workflows/w1",
      status: "failed",
    };
    const refused = await overMcp();
    expect(refused.isError).toBe(true);
    const body = JSON.parse(refused.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(body.error_code).toBe("workflow_activation_required");
    expect(body.message).toBe("The saved change needs human review.");
    expect(body.details).toEqual(payload);

    payload = { status: "failed" };
    const bare = JSON.parse((await overMcp()).content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(bare.error_code).toBe("tool_failed");
    expect(bare.message).toBe("tool returned ok=false");
  });
});

describe("tools/dispatcher — draft-dependency (requires_draft) stub-ctx guard", () => {
  function draftDependentProvider(onExecute: () => void): ToolProvider {
    const descriptor: ToolDescriptor = {
      name: "_test_requires_draft",
      description: "reads the working draft",
      category: "tenant_read",
      inputSchema: { type: "object" },
      requires_draft: true,
    };
    return {
      name: "DraftDependentProvider",
      list: () => [descriptor],
      resolve: (n) =>
        n === "_test_requires_draft"
          ? {
              descriptor,
              executor: {
                kind: "conversation",
                tool: undefined as never,
                execute: async () => {
                  onExecute();
                  return { ok: true, data: { ran: true } };
                },
              },
            }
          : undefined,
    };
  }

  test("MCP + stub ctx → not_available_on_surface, executor NOT called", async () => {
    let executed = false;
    const registry = buildRegistry([
      draftDependentProvider(() => {
        executed = true;
      }),
    ]);
    const envelope = await dispatchTool(
      {
        registry,
        db: DB_STUB,
        principal: PRINCIPAL,
        mcpMode: "authoring",
        buildMcpStubCtx: () => ({}) as never,
      },
      { surface: "mcp", name: "_test_requires_draft", args: {} },
    );
    expect(envelope.status).toBe("not_available_on_surface");
    if (envelope.status === "not_available_on_surface") {
      expect(envelope.reason).toBe(DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON);
    }
    expect(executed).toBe(false);
  });

  test("chat + real conversationCtx → executes normally (guard does not fire)", async () => {
    let executed = false;
    const registry = buildRegistry([
      draftDependentProvider(() => {
        executed = true;
      }),
    ]);
    const envelope = await dispatchTool(
      {
        registry,
        db: DB_STUB,
        principal: PRINCIPAL,
        conversationCtx: {} as never,
      },
      { surface: "chat", name: "_test_requires_draft", args: {} },
    );
    expect(envelope.status).toBe("ok");
    expect(executed).toBe(true);
  });
});

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

  test("input as a JSON STRING vs an OBJECT produce the SAME args_hash on the paused approval", async () => {
    const principal = dbPrincipal();
    const registry = buildRegistry([runWorkflowStub(() => {})]);
    const inputObject = { city: "Berlin" };

    const objectEnvelope = await dispatchTool(
      { registry, db: testDb.db, principal, conversationCtx: {} as never, permissionMode: "ask" },
      {
        surface: "chat",
        name: "run_workflow",
        args: {
          workflow: "invoice-export",
          environment: "prod",
          input: inputObject,
          execute_writes: true,
        },
      },
    );
    const stringEnvelope = await dispatchTool(
      { registry, db: testDb.db, principal, conversationCtx: {} as never, permissionMode: "ask" },
      {
        surface: "chat",
        name: "run_workflow",
        args: {
          workflow: "invoice-export",
          environment: "prod",
          input: JSON.stringify(inputObject),
          execute_writes: true,
        },
      },
    );
    expect(objectEnvelope.status).toBe("needs_confirm");
    expect(stringEnvelope.status).toBe("needs_confirm");
    const [objectConfirmId, stringConfirmId] = [objectEnvelope, stringEnvelope].map((e) =>
      e.status === "needs_confirm" ? e.confirm.tool_call_id : null,
    );
    expect(objectConfirmId).toBeTruthy();
    expect(stringConfirmId).toBeTruthy();

    const argsHashOf = async (confirmId: string): Promise<string | undefined> => {
      const rows = await approvalAuditRows(confirmId);
      const requested = rows.find((r) => r.action === AuditAction.APPROVAL_REQUESTED);
      return (requested!.metadata as { args_hash?: string } | undefined)?.args_hash;
    };
    const objectHash = await argsHashOf(objectConfirmId as string);
    const stringHash = await argsHashOf(stringConfirmId as string);
    expect(objectHash).toBeDefined();
    expect(objectHash).toBe(stringHash);
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
