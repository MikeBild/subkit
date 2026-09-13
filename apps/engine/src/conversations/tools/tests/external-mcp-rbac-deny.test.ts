// Negative RBAC contract for external `mcp_<ns>__<tool>` tools: a principal
// WITHOUT `mcp_external_tool:invoke` is refused BEFORE any outbound call
// leaves the tenant perimeter. The deny envelope mirrors the deny branch in
// `sdk-wrap/external-mcp-tools.ts` exactly (denied:true + the permission
// name + status:failed), and the fake remote client's `callTool` must never
// fire.
//
// PRINCIPAL SEEDING: the RBAC catalog + built-in roles are seeded via
// `seedBuiltinRolesAndPermissions`, and the principal carries the `enduser`
// built-in role — which deliberately does NOT include
// `mcp_external_tool:invoke` (see rbac/seed.ts ENDUSER_PERMISSIONS). No
// `admin` role → no builtin-admin short-circuit → the evaluator resolves the
// role's permission set and denies.
//
// INJECTION PATTERN: a REAL mcp connector row is registered and the pool's
// documented TEST SEAM (`__setMcpPoolFactoriesForTests`) swaps only the SDK
// Client construction for an in-process fake — NO bun `mock.module` (module
// mocks are process-global and leak into every other test file in the same
// worker). Mirrors external-mcp-pending-output.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { closeDb, type Db } from "../../../db/client.ts";
import { conversations, conversationToolCalls, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../../mcp/client/test-fixtures.ts";
import { seedBuiltinRolesAndPermissions } from "../../../rbac/seed.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import type { TurnSignals } from "../sdk-wrap.ts";
import { buildExternalMcpTools } from "../sdk-wrap/external-mcp-tools.ts";

// Counts remote invocations: the RBAC gate must fire BEFORE any `callTool`
// reaches the (fake) remote server.
let remoteCallToolCalls = 0;

const fakeClient: McpClientLike = {
  async connect() {},
  async listTools() {
    return {
      tools: [
        {
          name: "create_page",
          description: "Create a page on the remote server",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  },
  async callTool() {
    remoteCallToolCalls += 1;
    return { content: [], isError: false };
  },
  async readResource() {
    return { contents: [] };
  },
  async getPrompt() {
    return { messages: [] };
  },
  async close() {},
};

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
const _origDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createTestDb("external-mcp-rbac-deny");
  // Pin DATABASE_URL + reset the global pool so any getDb() fallback inside
  // the real pool/handshake path dials this suite's isolated test database
  // (same discipline as the pool-*.test.ts suites).
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-mcp-rbac-deny", display_name: "MCP RBAC Deny" })
    .returning();
  tenant_id = t!.id;
  actor_id = "00000000-0000-0000-0000-000000000003";
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = conv!.id;

  // Live RBAC rows: the permission catalog plus the built-in roles, so the
  // evaluator resolves a real deny (not an unknown-permission fallback).
  await seedBuiltinRolesAndPermissions(ctx.db as unknown as Db);

  // Real server row — `none` auth so the (fake) handshake needs no credential.
  await seedMcpConnector(ctx.db, {
    tenant_id,
    slug: "denymcp",
    transport: "http",
    url: "https://denymcp.rbactest.example.com/mcp",
  });
}, 30_000);

afterAll(async () => {
  // ALWAYS restore the seam (null-by-default protects production, but a
  // leaked non-null factory would still poison sibling test files).
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (_origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = _origDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

describe("external MCP tool RBAC deny", () => {
  test("a principal without mcp_external_tool:invoke is refused before any remote call", async () => {
    __resetMcpClientPoolForTests();
    remoteCallToolCalls = 0;
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
    // `enduser` deliberately lacks mcp_external_tool:invoke; there is no
    // users row for this id either, so no grant/group path can allow it.
    const principal: ResolvedPrincipal = {
      provider: "test",
      kind: "user",
      id: actor_id,
      tenant_id,
      roles: ["enduser"],
    };

    const tools = await buildExternalMcpTools({
      db,
      principal,
      ctx: toolCtx,
      signals: freshSignals(),
      events,
    });
    const toolName = "mcp_denymcp__create_page";
    expect(Object.keys(tools)).toContain(toolName);

    const execute = (
      tools[toolName] as unknown as {
        execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; data: unknown }>;
      }
    ).execute;
    // Even a confirmed call must be refused — RBAC fires before the policy
    // gate, so the confirmation marker cannot bypass it.
    const result = await execute({ title: "Anything", __policy_confirmed: true });

    expect(result.ok).toBe(false);
    const data = result.data as Record<string, unknown>;
    // Mirror the deny-branch envelope in external-mcp-tools.ts exactly.
    expect(data.ok).toBe(false);
    expect(data.denied).toBe(true);
    expect(data.permission).toBe("mcp_external_tool:invoke");
    expect(data.status).toBe("failed");
    expect(String(data.reason)).toContain("permission_denied");

    // The deny surfaced as a persisted tool_result event too.
    const resultEvent = events.find((e) => e.type === "tool_result");
    expect(resultEvent).toBeDefined();

    // The persisted tool-call row carries `{ denied: true }` as its input —
    // NEVER the denied principal's raw argument values (possible PII bound
    // for a third-party server). RBAC resolves BEFORE the row is inserted.
    const persisted = await ctx.db
      .select({ tool: conversationToolCalls.tool, input: conversationToolCalls.input })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.tenant_id, tenant_id));
    const denyRow = persisted.find((r) => r.tool === toolName);
    expect(denyRow).toBeDefined();
    expect(denyRow!.input).toEqual({ denied: true });
    const persistedInput = JSON.stringify(denyRow!.input);
    expect(persistedInput).not.toContain("Anything");
    expect(persistedInput).not.toContain("title");
    expect(persistedInput).not.toContain("__policy_confirmed");

    // The remote tool was NEVER invoked — the deny precedes any outbound call.
    expect(remoteCallToolCalls).toBe(0);
  });
});
