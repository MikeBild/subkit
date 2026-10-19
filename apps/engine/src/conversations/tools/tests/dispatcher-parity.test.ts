import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { makeStubDb, usePolicyFixture } from "../../../tools/tests/_helpers.ts";
import { invokeForSdk } from "../dispatch-adapter.ts";
import type { ToolContext, ToolResult } from "../index.ts";

usePolicyFixture();

const PRINCIPAL: ResolvedPrincipal = {
  kind: "user",
  id: "00000000-0000-0000-0000-000000000001",
  tenant_id: "00000000-0000-4000-8000-000000000002",
  authoring_role_id: null,
  scopes: new Set(),
  permission_grants: [],
  role_ids: [],
  api_key_id: null,
  // biome-ignore lint/suspicious/noExplicitAny: test stub
} as any;

function stubCtx(): ToolContext {
  return {
    db: makeStubDb().db,
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

describe("conversations/tools — invokeForSdk envelope parity", () => {
  test("unknown tool returns ToolResult.ok=false with structured error_code", async () => {
    const result: ToolResult = await invokeForSdk({
      db: makeStubDb().db,
      principal: PRINCIPAL,
      conversationCtx: stubCtx(),
      permissionMode: null,
      loadedSkills: new Set(),
      invocation: {
        surface: "chat",
        name: "definitely_not_a_tool_xyz",
        args: {},
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("tool_not_found");
      expect(result.message).toBeTruthy();
    }
  });

  test("envelope shape matches the ToolResult discriminator (ok:true | ok:false)", async () => {
    const result: ToolResult = await invokeForSdk({
      db: makeStubDb().db,
      principal: PRINCIPAL,
      conversationCtx: stubCtx(),
      permissionMode: null,
      loadedSkills: new Set(),
      invocation: {
        surface: "chat",
        name: "preview_attachment",
        args: { slug: "bogus", max_chars: 256 },
      },
    });
    expect(typeof result.ok).toBe("boolean");
    expect("status" in (result as unknown as Record<string, unknown>)).toBe(false);
  });

  test("dispatcher rejects draft_write tools on MCP surface via not_available_on_surface → ok=false", async () => {
    const result: ToolResult = await invokeForSdk({
      db: makeStubDb().db,
      principal: PRINCIPAL,
      conversationCtx: stubCtx(),
      permissionMode: null,
      loadedSkills: new Set(),
      invocation: {
        surface: "mcp",
        name: "save_workflow_draft",
        args: {},
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("not_available_on_surface");
    }
  });
});
