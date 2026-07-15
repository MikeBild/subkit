// Dispatcher pipeline tests.
//
// The dispatcher orchestrates: resolve → visibility → rbac → policy →
// audit → execute → normalize → log. Descriptor-level RBAC runs
// BEFORE the policy gate so an unauthorized caller never produces an
// APPROVAL_REQUESTED audit row; the "RBAC denial path" describe-block
// below pins this ordering. Per-tool RBAC declarations live on each
// provider's descriptor (see providers/conversation.ts:RBAC_OVERRIDES
// and providers/static.ts entries).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AuditAction, ToolDispatchPolicyDeniedMetadataSchema } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { runWorkflowTool } from "../../conversations/tools/generated/writes/run-workflow.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import { auditLog, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
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
// The zero-row update chain matters: the needs_confirm path calls
// `mintApprovalGrantUrl` whenever the AMBIENT config/env carries a
// public_base_url — under bun's parallel test files another suite's
// beforeAll/afterAll window (mcp-oauth audience tests) can set one
// concurrently, so this stub must survive that path instead of exploding
// with "db.update is not a function" depending on scheduling.
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

// Deterministic replacement for crypto.randomUUID() — same seed, same
// sequence, every run (determinism contract in apps/engine/AGENTS.md).
const nextId = createDeterministicUuidFactory(2);

// `consumeApproval` is DB-backed (a real CAS + AES-256-GCM round trip on
// `tool_approvals`) — a stub `db` can no longer stand in for it. The
// confirm-lifecycle tests below share one disposable Postgres database.
let testDb: TestDb;
let dbTenantId: string;

beforeAll(async () => {
  testDb = await createTestDb("dispatcher-confirm");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-dispatcher-confirm", display_name: "Dispatcher Confirm" })
    .returning();
  dbTenantId = tenant!.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

/** ResolvedPrincipal scoped to the real tenant `tool_approvals` FK-checks
 *  against. `principal_id` carries no FK (polymorphic), so only tenant_id
 *  needs to be real. */
function dbPrincipal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the PRINCIPAL stub above
  return { ...(PRINCIPAL as any), tenant_id: dbTenantId, ...overrides } as ResolvedPrincipal;
}

/** Audit rows keyed by `resource_id` (the confirm/approval id) — used to
 *  assert the APPROVAL_REQUESTED / APPROVAL_APPROVED lifecycle joins on a
 *  single id. */
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

  // MCP writes execute directly — the client's own destructiveHint dialog
  // gates the call before it reaches the engine, so `policyDecide` collapses
  // confirm_before_execution to `proceed` on `surface:"mcp"` (see
  // tools/policy.ts). No approval is ever minted for this call; contrast with
  // the "needs_confirm path" chat test right below, which proves chat is
  // unaffected.
  test("MCP tenant_write proceeds directly — no confirm gate, no minted approval", async () => {
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
      { registry, db: DB_STUB, principal: PRINCIPAL, conversationCtx: {} as never },
      { surface: "mcp", name: "_test_mcp_write_proceeds", args: {} },
    );
    expect(envelope.status).toBe("ok");
    if (envelope.status === "ok") {
      expect(envelope.data).toEqual({ ran: true });
    }
    expect(executed).toBe(true);
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
    // On MCP the confirm marker must reference a real, GRANTED, un-consumed
    // APPROVAL_REQUESTED. `consumeApproval` is a DB-backed CAS claim — seed
    // one for real via `requestApproval`, then grant it as the human would
    // via the approval portal, instead of stubbing the lookup.
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
});

describe("tools/dispatcher — draft-dependency (requires_draft) stub-ctx guard", () => {
  // A tenant_read tool marked requires_draft: it reads the conversation's
  // working draft. On the MCP stub-context path that draft is EMPTY, so the
  // dispatcher must reject the call with not_available_on_surface instead of
  // letting the executor run against nothing (the silent empty-draft no-op).
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
        // The MCP adapter always supplies a stub-ctx builder off-chat.
        buildMcpStubCtx: () => ({}) as never,
      },
      { surface: "mcp", name: "_test_requires_draft", args: {} },
    );
    expect(envelope.status).toBe("not_available_on_surface");
    if (envelope.status === "not_available_on_surface") {
      expect(envelope.reason).toBe(DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON);
    }
    // The empty-draft no-op never happened.
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
    // Track audit-insert calls so we can assert one POLICY_DENIED row
    // was emitted before execute() was skipped. The stub also has to
    // satisfy `can()`'s permission catalog walk — returning an empty
    // permissions row makes the check decline cleanly (no permission
    // by that name → no grant → deny).
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
      select: () => emptySelectChain,
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
    // Execute was skipped.
    expect(executed).toBe(false);
    // Exactly one POLICY_DENIED audit row was written, with the
    // resource details from the descriptor's resource() callback.
    const policyDenied = captured.filter((r) => r.action === "policy.denied");
    expect(policyDenied.length).toBe(1);
    expect(policyDenied[0]?.resource_type).toBe("test");
    expect(policyDenied[0]?.resource_id).toBe("abc");
    // The denial carries the approval-lifecycle args fingerprint (hash
    // only, never raw values) and conforms to the pinned emitter schema.
    const metadata = policyDenied[0]?.metadata ?? {};
    expect(metadata.args_hash).toBe(hashToolArgs({ id: "abc" }));
    expect(ToolDispatchPolicyDeniedMetadataSchema.parse(metadata)).toBeTruthy();
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

describe("tools/dispatcher — MCP confirmation + APPROVAL_APPROVED lifecycle (real Postgres)", () => {
  // `consumeApproval` is a real DB CAS claim, so these exercise it against
  // `testDb` (seeded via `beforeAll` above) rather than a select-stub. A
  // tenant_write tool with no descriptor.rbac, executor captures the args
  // it actually received — the property under test throughout this block
  // is WHICH args reach the executor, not what the caller sent.
  //
  // NOTE on surface: MCP no longer mints an approval through the normal
  // policy path — `policyDecide` collapses confirm_before_execution to
  // `proceed` on `surface:"mcp"`, so `gateConfirm` never fires there
  // (see the "MCP tenant_write proceeds directly" test above). The tests
  // below seed an approval directly via `requestApproval` (bypassing
  // `gateConfirm`/`policyDecide` entirely) to exercise the dispatcher's
  // generic confirm-marker claim mechanism — the same code path chat's
  // `ask_user_confirm` resolution drives operationally today. The `surface`
  // field on the approval is just part of the CAS predicate
  // (`consumeApproval`); it is not evidence that MCP still gates writes.
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
    // A model-suppliable confirm marker with no id can't be tied to any
    // APPROVAL_REQUESTED, so it must be rejected rather than executed —
    // otherwise it's a gate bypass. `consumeApproval` short-circuits before
    // touching the db (see approval.test.ts), so the plain DB_STUB suffices.
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
    // resource_id IS the carried tool_call_id → joins APPROVAL_REQUESTED.
    expect(rows.every((r) => r.resource_id === confirmId)).toBe(true);
  });

  // Rewrite of the old "confirmation_args_mismatch" test. The published
  // `confirm_tool_call` schema carries only `tool` + `confirm_id` — MCP's
  // handler always dispatches the confirmed re-issue with `args: {}`
  // (mcp/capabilities/tools.ts), so there is no client-supplied payload
  // left to "mismatch". The new contract: whatever a caller puts in `args`
  // at confirm time is IGNORED — `consumeApproval` hands back the args it
  // was granted at request time, and the dispatcher replaces `execArgs`
  // with those unconditionally. Proven here by smuggling a DIFFERENT `id`
  // at confirm time and asserting the executor still saw the granted one.
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
        // A buggy/hostile client smuggling a DIFFERENT id at confirm time —
        // the MCP responder never actually sends this (args: {} always),
        // but the dispatcher must not trust it even if something did.
        args: { id: "B" },
        meta: { sk_confirm: true, sk_confirm_id: confirmId },
      },
    );
    expect(envelope.status).toBe("ok");
    expect(received).toEqual([{ id: "A" }]);
  });

  test("CHAT confirm follows the same stored-args contract as MCP", async () => {
    // Chat carries the confirm id inside `args` (no transport `_meta`). The
    // claim binds the surface (a chat approval is not claimable over MCP), but
    // the replay contract is identical: the STORED args execute.
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
  // Uses run_workflow's REAL Zod schema (not a stand-in `{type:"object"}`
  // descriptor) so the `.transform()` on `input` and the `.default("dev")`
  // on `environment` are the actual ones canonicalizeArgs() runs against.
  // The executor is a stub — this block tests the dispatcher's
  // canonicalization step, not run_workflow's business logic.
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

    // `environment: "dev"` keeps run_workflow's TOOL_POLICIES predicate at
    // no_confirm (see conversations/tool-policies.ts) so both calls proceed
    // straight to the executor — the canonical args are observable directly.
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
    // Same canonical shape reached the executor both times — the object
    // form was never re-serialized, and the string form was parsed back
    // into an object, not left stringified.
    expect(received[0]?.input).toEqual(inputObject);
    expect(received[1]?.input).toEqual(inputObject);
    expect(received[0]).toEqual(received[1]);
  });

  test("input as a JSON STRING vs an OBJECT produce the SAME args_hash on the paused approval", async () => {
    // `environment: "prod"` forces run_workflow's confirm_before_execution
    // mode (no execute_writes / auto-approve), so the canonical args are
    // captured off the persisted APPROVAL_REQUESTED audit row's
    // `metadata.args_hash` instead of the executor. Surface is CHAT: on MCP
    // this same call collapses straight to `proceed` (`policyDecide`,
    // tools/policy.ts) — no approval is minted there to compare hashes on.
    const principal = dbPrincipal();
    const registry = buildRegistry([runWorkflowStub(() => {})]);
    const inputObject = { city: "Berlin" };

    const objectEnvelope = await dispatchTool(
      { registry, db: testDb.db, principal, conversationCtx: {} as never },
      {
        surface: "chat",
        name: "run_workflow",
        args: { workflow: "invoice-export", environment: "prod", input: inputObject },
      },
    );
    const stringEnvelope = await dispatchTool(
      { registry, db: testDb.db, principal, conversationCtx: {} as never },
      {
        surface: "chat",
        name: "run_workflow",
        args: {
          workflow: "invoice-export",
          environment: "prod",
          input: JSON.stringify(inputObject),
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

  test("run_workflow WITHOUT an explicit environment resolves to the 'dev' default BEFORE policyDecide runs", async () => {
    // Regression lock: canonicalizeArgs() must apply the Zod
    // `.default("dev")` BEFORE policyDecide() reads `args.environment`.
    // If policy ever saw the raw (environment-less) args again, run_workflow's
    // computeModeFromInput would fall through to its `else` branch and
    // demand a spurious confirm_before_execution for every dev-intent call
    // that simply omitted the field.
    const received: Array<Record<string, unknown>> = [];
    const registry = buildRegistry([runWorkflowStub((args) => received.push(args))]);
    const envelope = await dispatchTool(
      { registry, db: DB_STUB, principal: PRINCIPAL, conversationCtx: {} as never },
      { surface: "chat", name: "run_workflow", args: { workflow: "invoice-export" } },
    );
    expect(envelope.status).toBe("ok");
    expect(received).toHaveLength(1);
    expect(received[0]?.environment).toBe("dev");
  });
});
