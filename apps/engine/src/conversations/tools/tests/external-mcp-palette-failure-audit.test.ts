// A failure assembling the external-MCP tool palette must land a queryable
// audit row, not only a transient log line. `wrapTools` wraps
// `buildExternalMcpTools` in a best-effort try/catch; on failure it degrades
// to zero external tools AND emits `mcp_external_tool.palette_assembly_failed`.
//
// INJECTION PATTERN: the documented TEST SEAM
// `__setExternalMcpToolsBuilderForTests` (external-mcp-tools.ts) replaces the
// palette builder with one that throws — NO bun `mock.module` (module mocks
// are process-global and leak into every other test file in the same worker).
// The catch path then runs deterministically, and we assert: (1) the turn
// still returns its in-repo tools (no abort), and (2) the audit row carries
// the typed `pool_fault` reason plus a PRE-REDACTED metadata.detail — any
// URL embedded in the raw error is reduced to host-only (no path, no query
// string) before it is persisted.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import { auditLog, conversations, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { type TurnSignals, wrapTools } from "../sdk-wrap.ts";
import { __setExternalMcpToolsBuilderForTests } from "../sdk-wrap/external-mcp-tools.ts";

function freshSignals(): TurnSignals {
  return {
    step: 0,
    toolChain: Promise.resolve(),
    pendingChildToolCallIds: [],
    pendingChildElicitationIds: [],
    toolInvocationCount: new Map(),
    toolLastErrorHash: new Map(),
    toolArgsRepeat: new Map(),
    toolValidationFingerprint: new Map(),
    toolErrorCodeRepeat: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
    lastExecutionSuccess: null,
  };
}

let ctx: TestDb;
let tenant_id: string;
let actor_id: string;
let conversation_id: string;

beforeAll(async () => {
  // Force the palette assembly to throw — simulates a transport fault whose
  // raw message embeds the request URL WITH a query string (the shape a
  // fetch error produces). The persisted audit reason must carry host-only.
  __setExternalMcpToolsBuilderForTests(async () => {
    throw new Error(
      "enumeration blew up: GET https://mcp.example.test/rpc?session=topsecret123 returned 500",
    );
  });

  ctx = await createTestDb("external-mcp-palette-failure");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-palette-fail", display_name: "Palette Fail" })
    .returning();
  tenant_id = t!.id;
  actor_id = "00000000-0000-0000-0000-000000000001";
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = conv!.id;
}, 30_000);

afterAll(async () => {
  // ALWAYS restore the seam (null-by-default protects production, but a
  // leaked non-null builder would still poison sibling test files).
  __setExternalMcpToolsBuilderForTests(null);
  await ctx.cleanup();
}, 30_000);

describe("external MCP palette-assembly failure audit", () => {
  test("degrades to in-repo tools AND writes mcp_external_tool.palette_assembly_failed", async () => {
    const events: TurnEvent[] = [];
    const db = ctx.db as unknown as Db;
    const engineClient = new EngineClient({
      tenant_id,
      actor_id,
      actor_type: "user",
      db,
    });
    const toolCtx: ToolContext = {
      db,
      tenant_id,
      conversation_id,
      actor_id,
      connector_id: null,
      workflow_id: null,
      engineClient,
      getDraft: () => ({ workflow: { name: "", steps: [] } }),
      setDraft: async () => {},
    };
    const principal: ResolvedPrincipal = {
      provider: "test",
      kind: "user",
      id: actor_id,
      tenant_id,
      roles: ["admin"],
    };

    const wrapped = await wrapTools(toolCtx, freshSignals(), events, db, [], {}, null, principal);

    // The turn did NOT abort — in-repo tools are still present.
    expect(Object.keys(wrapped).length).toBeGreaterThan(0);

    // The degradation landed a queryable audit row (resource_id = tenant_id).
    const rows = await ctx.db
      .select({
        action: auditLog.action,
        result: auditLog.result,
        reason: auditLog.reason,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(eq(auditLog.resource_id, tenant_id));
    const failure = rows.filter((r) => r.action === "mcp_external_tool.palette_assembly_failed");
    expect(failure.length).toBe(1);
    expect(failure[0]!.result).toBe("error");
    // `reason` is the typed failure class (pool_fault is the catch-all for
    // a thrown palette assembly).
    expect(failure[0]!.reason).toBe("pool_fault");
    // The detail in metadata is pre-redacted: the embedded URL is reduced to
    // host-only — no path segment and no query string (which can carry
    // session/token material) ever reaches the audit row.
    const meta = failure[0]!.metadata as Record<string, unknown>;
    expect(meta.detail).toBe("enumeration blew up: GET https://mcp.example.test returned 500");
    const metaStr = JSON.stringify(meta);
    expect(metaStr).not.toContain("topsecret123");
    expect(metaStr).not.toContain("/rpc");
  });
});
