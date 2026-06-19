// Dispatcher pipeline tests.
//
// The dispatcher orchestrates: resolve → visibility → rbac → policy →
// audit → execute → normalize → log. Descriptor-level RBAC runs
// BEFORE the policy gate so an unauthorized caller never produces an
// APPROVAL_REQUESTED audit row; the "RBAC denial path" describe-block
// below pins this ordering. Per-tool RBAC declarations live on each
// provider's descriptor (see providers/conversation.ts:RBAC_OVERRIDES
// and providers/static.ts entries).

import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { dispatchTool } from "../dispatcher.ts";
import { conversationToolProvider, staticToolProvider } from "../index.ts";
import { DRAFT_WRITE_MCP_UNAVAILABLE_REASON } from "../policy.ts";
import { buildRegistry, type ToolProvider } from "../registry.ts";
import type { ToolDescriptor, ToolEnvelope } from "../types.ts";

// A bare-minimum ResolvedPrincipal stub — the dispatcher only reads
// id and tenant_id for the audit + log envelopes.
const PRINCIPAL: ResolvedPrincipal = {
  kind: "user",
  id: "00000000-0000-0000-0000-000000000001",
  tenant_id: "00000000-0000-0000-0000-000000000002",
  authoring_role_id: null,
  scopes: new Set(),
  permission_grants: [],
  role_ids: [],
  api_key_id: null,
  // biome-ignore lint/suspicious/noExplicitAny: stub for tests
} as any;

// The dispatcher hits auditAwait() on confirm paths; we pass a stub `db`
// that satisfies the type without exercising real Postgres. The audit
// helper logs on failure rather than throwing.
// biome-ignore lint/suspicious/noExplicitAny: stub for tests
const DB_STUB: any = {
  transaction: async (fn: (db: unknown) => unknown) => fn(DB_STUB),
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
};

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
    const envelope = await dispatchTool(
      {
        registry,
        db: DB_STUB,
        principal: PRINCIPAL,
        conversationCtx: {} as never,
      },
      {
        surface: "mcp",
        name: "_test_confirmed_write",
        args: {},
        meta: { sk_confirm: true },
      },
    );
    expect(envelope.status).toBe("ok");
    if (envelope.status === "ok") {
      expect(envelope.data).toEqual({ ran: true });
    }
    expect(executed).toBe(true);
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
});

describe("tools/dispatcher — RBAC denial path", () => {
  test("descriptor.rbac deny → status:'error' error_code:'policy_denied' AND POLICY_DENIED audit row", async () => {
    // Track audit-insert calls so we can assert one POLICY_DENIED row
    // was emitted before execute() was skipped. The stub also has to
    // satisfy `can()`'s permission catalog walk — returning an empty
    // permissions row makes the check decline cleanly (no permission
    // by that name → no grant → deny).
    const captured: Array<{
      action?: string | undefined;
      resource_type?: string | undefined;
      resource_id?: string | undefined;
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
      select: () => emptySelectChain,
      insert: () => ({
        values: (row: {
          action?: string | undefined;
          resource_type?: string | undefined;
          resource_id?: string | undefined;
        }) => {
          captured.push({
            action: row?.action,
            resource_type: row?.resource_type,
            resource_id: row?.resource_id,
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
    // Execute was skipped.
    expect(executed).toBe(false);
    // Exactly one POLICY_DENIED audit row was written, with the
    // resource details from the descriptor's resource() callback.
    const policyDenied = captured.filter((r) => r.action === "policy.denied");
    expect(policyDenied.length).toBe(1);
    expect(policyDenied[0]?.resource_type).toBe("test");
    expect(policyDenied[0]?.resource_id).toBe("abc");
  });

  test("RBAC runs BEFORE policy gate — denied tenant_write does NOT emit APPROVAL_REQUESTED", async () => {
    // The reordering of the pipeline puts RBAC before the policy gate.
    // A tenant_write tool with descriptor.rbac denied must not produce
    // an APPROVAL_REQUESTED audit row — only POLICY_DENIED.
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
      select: () => emptySelectChain,
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
    // No APPROVAL_REQUESTED — the deny short-circuits before the
    // policy gate would emit it. Exactly one POLICY_DENIED.
    expect(captured.filter((r) => r.action === "approval.requested").length).toBe(0);
    expect(captured.filter((r) => r.action === "policy.denied").length).toBe(1);
  });
});

describe("tools/dispatcher — APPROVAL_APPROVED orphan-row prevention", () => {
  test("sk_confirm:true WITHOUT sk_confirm_id → ok + NO APPROVAL_APPROVED row", async () => {
    // A legacy MCP client that re-issues a previously paused call
    // WITHOUT carrying the
    // original tool_call_id back must not produce an orphan
    // APPROVAL_APPROVED row that no APPROVAL_REQUESTED could ever
    // join. The dispatcher proceeds to execute (the client did
    // ack the confirm via sk_confirm:true) but skips the audit
    // emit and logs a structured warning.
    const captured: Array<{ action?: string | undefined }> = [];
    // biome-ignore lint/suspicious/noExplicitAny: drizzle chain shape stub
    const emptySelectChain: any = {
      from: () => emptySelectChain,
      where: () => emptySelectChain,
      leftJoin: () => emptySelectChain,
      innerJoin: () => emptySelectChain,
      limit: () => Promise.resolve([]),
      orderBy: () => Promise.resolve([]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: drizzle Db stub
    const captureDb: any = {
      transaction: async (fn: (db: unknown) => unknown) => fn(captureDb),
      select: () => emptySelectChain,
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
      name: "_test_confirm_no_id",
      description: "tenant_write, no rbac",
      category: "tenant_write",
      inputSchema: { type: "object" },
    };
    const provider: ToolProvider = {
      name: "ConfirmNoIdProvider",
      list: () => [watched],
      resolve: (n) =>
        n === "_test_confirm_no_id"
          ? {
              descriptor: watched,
              executor: {
                kind: "conversation",
                tool: undefined as never,
                execute: async () => ({ ok: true, data: { ran: true } }),
              },
            }
          : undefined,
    };
    const registry = buildRegistry([provider]);
    const envelope = await dispatchTool(
      { registry, db: captureDb, principal: PRINCIPAL, conversationCtx: {} as never },
      {
        surface: "mcp",
        name: "_test_confirm_no_id",
        args: {},
        // sk_confirm marker present, sk_confirm_id deliberately absent
        meta: { sk_confirm: true },
      },
    );

    // Execute still runs (the client did ack the confirm); envelope
    // is ok.
    expect(envelope.status).toBe("ok");
    if (envelope.status === "ok") {
      expect(envelope.data).toEqual({ ran: true });
    }
    // Critical: NO APPROVAL_APPROVED row written — no orphan that
    // can't join APPROVAL_REQUESTED via tool_call_id.
    expect(captured.filter((r) => r.action === "approval.approved").length).toBe(0);
  });

  test("sk_confirm:true WITH sk_confirm_id → ok + exactly one APPROVAL_APPROVED row using that id", async () => {
    const captured: Array<{
      action?: string | undefined;
      resource_id?: string | undefined;
    }> = [];
    // biome-ignore lint/suspicious/noExplicitAny: drizzle chain shape stub
    const emptySelectChain: any = {
      from: () => emptySelectChain,
      where: () => emptySelectChain,
      leftJoin: () => emptySelectChain,
      innerJoin: () => emptySelectChain,
      limit: () => Promise.resolve([]),
      orderBy: () => Promise.resolve([]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: drizzle Db stub
    const captureDb: any = {
      transaction: async (fn: (db: unknown) => unknown) => fn(captureDb),
      select: () => emptySelectChain,
      insert: () => ({
        values: (row: {
          action?: string | undefined;
          resource_type?: string | undefined;
          resource_id?: string | undefined;
        }) => {
          captured.push({ action: row?.action, resource_id: row?.resource_id });
          return { onConflictDoNothing: async () => undefined };
        },
      }),
    };

    const watched: ToolDescriptor = {
      name: "_test_confirm_with_id",
      description: "tenant_write, no rbac",
      category: "tenant_write",
      inputSchema: { type: "object" },
    };
    const provider: ToolProvider = {
      name: "ConfirmWithIdProvider",
      list: () => [watched],
      resolve: (n) =>
        n === "_test_confirm_with_id"
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
    const carriedId = "11111111-2222-3333-4444-555555555555";
    const envelope = await dispatchTool(
      { registry, db: captureDb, principal: PRINCIPAL, conversationCtx: {} as never },
      {
        surface: "mcp",
        name: "_test_confirm_with_id",
        args: {},
        meta: { sk_confirm: true, sk_confirm_id: carriedId },
      },
    );

    expect(envelope.status).toBe("ok");
    const approved = captured.filter((r) => r.action === "approval.approved");
    expect(approved.length).toBe(1);
    // The audit row's resource_id IS the carried tool_call_id, so a
    // compliance query joining APPROVAL_REQUESTED ↔ APPROVAL_APPROVED
    // on resource_id closes the lifecycle.
    expect(approved[0]?.resource_id).toBe(carriedId);
  });
});
