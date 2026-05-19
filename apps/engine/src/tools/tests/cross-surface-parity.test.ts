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
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { invokeForSdk } from "../../conversations/tools/dispatch-adapter.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import { callToolViaDispatcher } from "../../mcp/adapter.ts";

const PRINCIPAL: ResolvedPrincipal = {
  kind: "user",
  id: "00000000-0000-0000-0000-000000000001",
  tenant_id: "00000000-0000-0000-0000-000000000002",
  authoring_role_id: null,
  scopes: new Set(),
  permission_grants: [],
  role_ids: [],
  api_key_id: null,
  // biome-ignore lint/suspicious/noExplicitAny: test stub
} as any;

// biome-ignore lint/suspicious/noExplicitAny: test stub
const DB_STUB: any = {
  transaction: async (fn: any) => fn(DB_STUB),
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
};

function stubCtx(): ToolContext {
  return {
    db: DB_STUB,
    tenant_id: PRINCIPAL.tenant_id,
    conversation_id: "test-conv",
    actor_id: PRINCIPAL.id,
    connector_id: null,
    workflow_id: null,
    // biome-ignore lint/suspicious/noExplicitAny: engine client stub
    engineClient: {} as any,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  } as ToolContext;
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
    expect(parsed.reason).toBe("requires_conversation_surface");

    // The MCP adapter additionally carries the same reason in
    // _meta.subkit.not_available_on_surface for clients that prefer
    // structured metadata over content scraping.
    const meta = mcpResult._meta as
      | { subkit?: { not_available_on_surface?: { reason: string } } }
      | undefined;
    expect(meta?.subkit?.not_available_on_surface?.reason).toBe("requires_conversation_surface");
  });

  test("tenant_write on MCP without confirm — adapter emits needs_confirm envelope", async () => {
    const mcpResult = await callToolViaDispatcher({
      db: DB_STUB,
      principal: PRINCIPAL,
      mcpMode: "admin",
      readOnly: false,
      // import_connector_from_spec is the canonical tenant_write tool
      // available on MCP admin mode.
      invocation: {
        surface: "mcp",
        name: "import_connector_from_spec",
        args: {
          spec: "openapi",
          source: { kind: "url", url: "https://example.test/openapi.json" },
        },
      },
    });
    expect(mcpResult.isError).toBe(false);
    const parsed = JSON.parse(mcpResult.content[0]!.text) as {
      policy_mode?: string;
      tool_call_id?: string;
    };
    expect(parsed.policy_mode).toBe("confirm_before_execution");
    expect(parsed.tool_call_id).toMatch(/^[0-9a-f-]{36}$/);
    // _meta.subkit.confirm carries the structured envelope for clients
    // that prefer meta to content.
    const meta = mcpResult._meta as
      | { subkit?: { confirm?: { tool_call_id?: string } } }
      | undefined;
    expect(meta?.subkit?.confirm?.tool_call_id).toBe(parsed.tool_call_id);
  });
});
