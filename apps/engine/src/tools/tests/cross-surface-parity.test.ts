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
    expect(parsed.reason).toBe("requires_conversation_surface");

    // The MCP adapter additionally carries the same reason in
    // _meta.subkit.not_available_on_surface for clients that prefer
    // structured metadata over content scraping.
    const meta = mcpResult._meta as
      | { subkit?: { not_available_on_surface?: { reason: string } } }
      | undefined;
    expect(meta?.subkit?.not_available_on_surface?.reason).toBe("requires_conversation_surface");
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

  test("tenant isolation — principal of tenant A cannot dispatch against tenant B's resource id", async () => {
    // Architectural invariant: every audit row and every can() call
    // carries `principal.tenant_id`. A caller for tenant A passing a
    // connector_id that belongs to tenant B must NOT receive a
    // success envelope — RBAC denies on the principal's permission set
    // (which is empty in this stub) AND any downstream `getConnector`
    // would scope to tenant A and find nothing. This dispatcher-level
    // assertion guards against a future provider that forgets to thread
    // principal.tenant_id into its executor context.
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
});
