// Cross-surface parity — the load-bearing oracle that proves chat and
// MCP get structurally equivalent envelopes from the same call.
//
// Since chat doesn't go through `invokeForSdk` at runtime (it stays on
// `sdk-wrap.ts`), we exercise both adapters directly:
//
//   chat side  : invokeForSdk(...) → ToolResult (legacy ok-shape)
//   MCP side   : callToolViaDispatcher(...) → {isError, content[]}
//
// Both paths fan out to the same dispatcher → same registry → same
// executor. The test asserts:
//   - structurally equivalent payloads (modulo wrapping)
//   - same audit decision (no double-dispatch)
//   - same not_available_on_surface short-circuit for draft_write

import { describe, expect, test } from "bun:test";
import { invokeForSdk } from "../../conversations/tools/dispatch-adapter.ts";
import { callToolViaDispatcher } from "../../mcp/adapter.ts";
import { DRAFT_WRITE_MCP_UNAVAILABLE_REASON } from "../policy.ts";
import { makeStubCtx, makeStubDb, makeTestPrincipal } from "./_helpers.ts";

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

    // Chat: ok-discriminated with error_code.
    expect(chatResult.ok).toBe(false);
    if (!chatResult.ok) {
      expect(chatResult.error_code).toBe("tool_not_found");
    }

    // MCP: isError + JSON-encoded error envelope.
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
      // Force MCP surface in the invocation to exercise the gate on
      // both wrappers. Chat surface itself would proceed.
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

    // The MCP adapter additionally carries the same reason in
    // _meta.subkit.not_available_on_surface for clients that prefer
    // structured metadata over content scraping.
    const meta = mcpResult._meta as
      | { subkit?: { not_available_on_surface?: { reason: string } } }
      | undefined;
    expect(meta?.subkit?.not_available_on_surface?.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);
  });

  test("tenant_write on MCP without permission — RBAC denies BEFORE policy gate", async () => {
    // The test stub principal has no permissions, so `can()` denies
    // import_connector_from_spec's declared `connector:write`. The
    // dispatcher's RBAC step runs before the policy gate, so the
    // caller sees status:'error' error_code:'policy_denied' rather
    // than a confirm prompt. This locks the architect-HIGH fix (RBAC
    // runs first; unauthorized callers don't pollute the audit log
    // with APPROVAL_REQUESTED).
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
    // Dispatcher-layer tenant-isolation invariant: every audit row and
    // every can() call carries `principal.tenant_id`. A tenant-A
    // principal passing a tenant-B connector_id receives policy_denied
    // (no permission for the stub principal) and the POLICY_DENIED
    // audit row records principal A's tenant_id with B's resource_id.
    //
    // Scope NOTE: This covers the dispatcher layer only. Executor-level
    // tenant scoping (the WHERE clause in `getConnector(tenant_id, id)`)
    // is the second defense; it's covered by
    // `connectors/service.ts:getConnector` tests and exercised
    // end-to-end by `mcp/tests/test-connector-dedupe.test.ts:75-90`
    // (unknown connector_id → connector_not_found). The true
    // multi-tenant integration test lives in
    // `mcp/tests/cross-tenant-executor-isolation.test.ts`: an
    // RBAC-passing tenant-A key probing a real tenant-B connector
    // gets connector_not_found from the executor WHERE clause.
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
    // RBAC denial fires first (no permission); the connector lookup
    // never runs. The audit row carries principal A's tenant_id and
    // the foreign resource id, recording the attempt.
    expect(data.error_code).toBe("policy_denied");
    const denied = capture.inserts.filter((r) => r.action === "policy.denied");
    expect(denied.length).toBe(1);
    expect(denied[0]?.tenant_id).toBe(principalA.tenant_id);
    expect(denied[0]?.resource_id).toBe(foreignConnectorId);
  });

  test("tenant isolation (executor layer) — principal.tenant_id (not args) is threaded into the executor context", async () => {
    // Architectural guard: the dispatcher must build the executor ctx
    // from `principal.tenant_id`, NOT from args. A future provider
    // that derives ctx.tenant_id from args (e.g., trusts a client-
    // supplied tenant_id parameter) would break tenant isolation
    // at the executor layer — `getConnector(ctx.tenant_id, args.id)`
    // would query against the caller-controlled tenant_id.
    const principalA = makeTestPrincipal({
      tenant_id: "00000000-0000-0000-0000-cccccccccccc",
    });
    const { db } = makeStubDb();
    let observedTenantId: string | undefined;
    // Synthesize a tool whose executor captures the ctx it receives.
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
    // Build a one-off registry with our capture provider.
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
        // Caller-controlled tenant_id-shaped fields are IGNORED by the
        // dispatcher's ctx construction — only principal.tenant_id wins.
        args: { tenant_id: "00000000-0000-0000-0000-ddddddddDEAD" },
      },
    );
    expect(envelope.status).toBe("ok");
    expect(observedTenantId).toBe(principalA.tenant_id);
  });
});
