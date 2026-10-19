import { describe, expect, test } from "bun:test";
import { invokeForSdk } from "../../conversations/tools/dispatch-adapter.ts";
import { callToolViaDispatcher } from "../../mcp/adapter.ts";
import { DRAFT_WRITE_MCP_UNAVAILABLE_REASON } from "../policy.ts";
import { makeStubCtx, makeStubDb, makeTestPrincipal, usePolicyFixture } from "./_helpers.ts";

usePolicyFixture();

const PRINCIPAL = makeTestPrincipal();
const { db: DB_STUB } = makeStubDb();
function stubCtx() {
  return makeStubCtx({ db: DB_STUB, principal: PRINCIPAL });
}

describe("tools/cross-surface-parity", () => {
  test("unknown tool — both surfaces emit tool_not_found in their native shape", async () => {
    const chatResult = await invokeForSdk({
      db: DB_STUB,
      principal: PRINCIPAL,
      conversationCtx: stubCtx(),
      permissionMode: null,
      loadedSkills: new Set(),
      invocation: { surface: "chat", name: "no_such_tool", args: {} },
    });
    const mcpResult = await callToolViaDispatcher({
      db: DB_STUB,
      principal: PRINCIPAL,
      mcpMode: "authoring",
      readOnly: false,
      invocation: { surface: "mcp", name: "no_such_tool", args: {} },
    });

    expect(chatResult.ok).toBe(false);
    if (!chatResult.ok) {
      expect(chatResult.error_code).toBe("tool_not_found");
    }

    expect(mcpResult.isError).toBe(true);
    const parsed = JSON.parse(mcpResult.content[0]!.text) as {
      error_code?: string;
    };
    expect(parsed.error_code).toBe("tool_not_found");
  });

  test("draft_write tool — both surfaces honor not_available_on_surface", async () => {
    const chatResult = await invokeForSdk({
      db: DB_STUB,
      principal: PRINCIPAL,
      conversationCtx: stubCtx(),
      permissionMode: null,
      loadedSkills: new Set(),
      invocation: { surface: "mcp", name: "save_workflow_draft", args: {} },
    });
    const mcpResult = await callToolViaDispatcher({
      db: DB_STUB,
      principal: PRINCIPAL,
      mcpMode: "authoring",
      readOnly: false,
      invocation: { surface: "mcp", name: "save_workflow_draft", args: {} },
    });

    expect(chatResult.ok).toBe(false);
    if (!chatResult.ok) {
      expect(chatResult.error_code).toBe("not_available_on_surface");
    }
    expect(mcpResult.isError).toBe(true);
    const parsed = JSON.parse(mcpResult.content[0]!.text) as {
      error_code?: string;
      reason?: string;
    };
    expect(parsed.error_code).toBe("not_available_on_surface");
    expect(parsed.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);

    const meta = mcpResult._meta as
      | { subkit?: { not_available_on_surface?: { reason: string } } }
      | undefined;
    expect(meta?.subkit?.not_available_on_surface?.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);
  });

  test("tenant_write on MCP without permission — RBAC denies BEFORE policy gate", async () => {
    const mcpResult = await callToolViaDispatcher({
      db: DB_STUB,
      principal: PRINCIPAL,
      mcpMode: "admin",
      readOnly: false,
      invocation: {
        surface: "mcp",
        name: "import_connector_from_spec",
        args: {
          spec: "openapi",
          source: { kind: "url", url: "https://example.test/openapi.json" },
        },
      },
    });
    expect(mcpResult.isError).toBe(true);
    const parsed = JSON.parse(mcpResult.content[0]!.text) as {
      error_code?: string;
    };
    expect(parsed.error_code).toBe("policy_denied");
  });

  test("tenant isolation (dispatcher layer) — RBAC deny carries principal's tenant_id + foreign resource_id", async () => {
    const principalA = makeTestPrincipal({
      tenant_id: "00000000-0000-0000-0000-aaaaaaaaaaaa",
    });
    const { db, capture } = makeStubDb();
    const foreignConnectorId = "00000000-0000-0000-0000-bbbbbbbbbbbb";
    const mcpResult = await callToolViaDispatcher({
      db,
      principal: principalA,
      mcpMode: "admin",
      readOnly: false,
      invocation: {
        surface: "mcp",
        name: "test_connector",
        args: { connector_id: foreignConnectorId },
      },
    });
    expect(mcpResult.isError).toBe(true);
    const data = JSON.parse(mcpResult.content[0]!.text) as {
      error_code?: string;
    };
    expect(data.error_code).toBe("policy_denied");
    const denied = capture.inserts.filter((r) => r.action === "policy.denied");
    expect(denied.length).toBe(1);
    expect(denied[0]?.tenant_id).toBe(principalA.tenant_id);
    expect(denied[0]?.resource_id).toBe(foreignConnectorId);
  });

  test("tenant isolation (executor layer) — principal.tenant_id (not args) is threaded into the executor context", async () => {
    const principalA = makeTestPrincipal({
      tenant_id: "00000000-0000-0000-0000-cccccccccccc",
    });
    const { db } = makeStubDb();
    let observedTenantId: string | undefined;
    const captureProvider = {
      name: "TenantCaptureProvider",
      list: () => [
        {
          name: "_capture_ctx",
          description: "captures ctx for test",
          category: "tenant_read" as const,
          inputSchema: { type: "object" as const },
        },
      ],
      resolve: (n: string) =>
        n === "_capture_ctx"
          ? {
              descriptor: {
                name: "_capture_ctx",
                description: "captures ctx for test",
                category: "tenant_read" as const,
                inputSchema: { type: "object" as const },
              },
              executor: {
                kind: "conversation" as const,
                tool: undefined as never,
                execute: async (ctx: { tenant_id: string }) => {
                  observedTenantId = ctx.tenant_id;
                  return { ok: true as const, data: {} };
                },
              },
            }
          : undefined,
    };
    const { buildRegistry } = await import("../registry.ts");
    const { dispatchTool } = await import("../dispatcher.ts");
    const { buildMcpStubCtx } = await import("../../mcp/adapter.ts");
    const registry = buildRegistry([captureProvider]);
    const envelope = await dispatchTool(
      {
        registry,
        db,
        principal: principalA,
        buildMcpStubCtx: () => buildMcpStubCtx({ db, principal: principalA }),
      },
      {
        surface: "mcp",
        name: "_capture_ctx",
        args: { tenant_id: "00000000-0000-0000-0000-ddddddddDEAD" },
      },
    );
    expect(envelope.status).toBe("ok");
    expect(observedTenantId).toBe(principalA.tenant_id);
  });
});
