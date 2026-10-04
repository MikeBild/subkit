// Conversation-side (chat surface) dispatch parity test.
//
// The chat path uses `sdk-wrap.ts` at runtime today (not the unified
// `invokeForSdk` adapter — chat is the canonical home of conversation
// tools, no duplication to remove). The adapter is wire-in-ready for a
// future cutover; this file proves it produces ToolResults compatible
// with what the chat loop expects, so the eventual cutover is safe.
//
// We exercise invokeForSdk directly with stub deps — no live LLM, no
// real conversation. The MCP-integration tests
// (mcp/tests/test-connector-dedupe.test.ts and friends) cover the same
// dispatcher through the MCP transport; this file pins the chat-shape
// adapter.

import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { invokeForSdk } from "../dispatch-adapter.ts";
import type { ToolContext, ToolResult } from "../index.ts";

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
  transaction: async (fn: (db: unknown) => unknown) => fn(DB_STUB),
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

describe("conversations/tools — invokeForSdk envelope parity", () => {
  test("unknown tool returns ToolResult.ok=false with structured error_code", async () => {
    const result: ToolResult = await invokeForSdk({
      db: DB_STUB,
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
    // Verify the back-conversion in envelopeToToolResult preserves the
    // discriminator the chat loop expects. We use a tool we know the
    // registry exposes on chat surface: preview_attachment is a safe
    // tenant_read tool that gracefully handles bogus slugs.
    const result: ToolResult = await invokeForSdk({
      db: DB_STUB,
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
    // The shape MUST be ok-discriminated — neither status nor the new
    // ToolEnvelope shape should leak out of the adapter.
    expect(typeof result.ok).toBe("boolean");
    expect("status" in (result as unknown as Record<string, unknown>)).toBe(false);
  });

  test("dispatcher rejects draft_write tools on MCP surface via not_available_on_surface → ok=false", async () => {
    // Even on the chat surface, we can prove the not_available_on_surface
    // path back-converts to ok:false rather than throwing. We synthesize
    // the MCP surface in the invocation so the policy short-circuits.
    const result: ToolResult = await invokeForSdk({
      db: DB_STUB,
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
