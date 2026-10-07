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
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { buildExternalMcpTools } from "../sdk-wrap/external-mcp-tools.ts";
import type { TurnSignals } from "../sdk-wrap.ts";

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
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-mcp-rbac-deny", display_name: "MCP RBAC Deny" })
    .returning();
  tenant_id = t!.id;
  actor_id = createDeterministicUuidFactory(322)();
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = conv!.id;

  await seedBuiltinRolesAndPermissions(ctx.db as unknown as Db);

  await seedMcpConnector(ctx.db, {
    tenant_id,
    slug: "denymcp",
    transport: "http",
    url: "https://denymcp.rbactest.example.com/mcp",
  });
}, 30_000);

afterAll(async () => {
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
    const result = await execute({ title: "Anything", __policy_confirmed: true });

    expect(result.ok).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.denied).toBe(true);
    expect(data.permission).toBe("mcp_external_tool:invoke");
    expect(data.status).toBe("failed");
    expect(String(data.reason)).toContain("permission_denied");

    const resultEvent = events.find((e) => e.type === "tool_result");
    expect(resultEvent).toBeDefined();

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

    expect(remoteCallToolCalls).toBe(0);
  });
});
