// W5 (#226): a failure assembling the external-MCP tool palette must land a
// queryable audit row, not only a transient log line. `wrapTools` wraps
// `buildExternalMcpTools` in a best-effort try/catch; on failure it degrades
// to zero external tools AND emits `mcp_external_tool.palette_assembly_failed`.
//
// We mock the external-mcp-tools module to throw BEFORE importing sdk-wrap so
// the catch path runs deterministically, then assert: (1) the turn still
// returns its in-repo tools (no abort), and (2) the audit row is written.
//
// MOCK PATTERN: mock.module() runs before the dynamic import of sdk-wrap.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import { auditLog, conversations, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import type { TurnSignals } from "../sdk-wrap.ts";

// Force buildExternalMcpTools to throw — simulates a DB error enumerating
// connectable servers / a pool fault.
mock.module("../sdk-wrap/external-mcp-tools.ts", () => ({
  buildExternalMcpTools: async () => {
    throw new Error("enumeration blew up");
  },
}));

const { wrapTools } = await import("../sdk-wrap.ts");

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
  };
}

let ctx: TestDb;
let tenant_id: string;
let actor_id: string;
let conversation_id: string;

beforeAll(async () => {
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
  mock.restore();
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
      .select({ action: auditLog.action, result: auditLog.result, reason: auditLog.reason })
      .from(auditLog)
      .where(eq(auditLog.resource_id, tenant_id));
    const failure = rows.filter((r) => r.action === "mcp_external_tool.palette_assembly_failed");
    expect(failure.length).toBe(1);
    expect(failure[0]!.result).toBe("error");
    expect(failure[0]!.reason).toBe("enumeration blew up");
  });
});
