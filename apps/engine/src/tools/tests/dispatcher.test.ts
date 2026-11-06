import { describe, expect, test } from "bun:test";
import { AuditAction } from "../../audit/types.ts";
import { envelopeToMcpResponse } from "../../mcp/adapter.ts";
import { grantApproval, requestApproval } from "../approval.ts";
import { dispatchTool } from "../dispatcher.ts";
import { conversationToolProvider, staticToolProvider } from "../index.ts";
import {
  DRAFT_REQUIRED_MCP_UNAVAILABLE_REASON,
  DRAFT_WRITE_MCP_UNAVAILABLE_REASON,
} from "../policy.ts";
import { buildRegistry, type ToolProvider } from "../registry.ts";
import type { ToolDescriptor, ToolEnvelope } from "../types.ts";
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

  test("executor throwing → status:'error' error_code:'tool_execution_failed'", async () => {
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
      expect(envelope.error_code).toBe("tool_execution_failed");
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
    expect(bare.message).toBe("the tool reported a failure without details");
    expect(bare.next_best_actions).toEqual([]);
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
