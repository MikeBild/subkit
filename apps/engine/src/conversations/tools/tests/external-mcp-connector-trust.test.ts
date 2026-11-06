import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { setMcpToolConfirmation } from "../../../connectors/mcp-tool-trust.ts";
import { closeDb, type Db } from "../../../db/client.ts";
import { auditLog, conversations } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../../mcp/client/test-fixtures.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
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
        {
          name: "search_items",
          description: "Search items on the remote server",
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
let connector_id: string;
const _origDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createTestDb("external-mcp-connector-trust");
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  tenant_id = (
    await seedTenant(ctx.db, { slug: "t-mcp-trust", display_name: "MCP Connector Trust" })
  ).id;
  actor_id = createDeterministicUuidFactory(318)();
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = conv!.id;

  const seeded = await seedMcpConnector(ctx.db, {
    tenant_id,
    slug: "examplemcp",
    transport: "http",
    url: "https://examplemcp.trusttest.example.com/mcp",
  });
  connector_id = seeded.id;
  await setMcpToolConfirmation(ctx.db, {
    tenant_id,
    connector_id,
    tool: "search_items",
    confirm: false,
    actor_id: null,
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

type Exec = (input: Record<string, unknown>) => Promise<{ ok: boolean; data: unknown }>;

async function palette(permission_mode?: "plan") {
  __resetMcpClientPoolForTests();
  const events: TurnEvent[] = [];
  const db = ctx.db as unknown as Db;
  const engineClient = new EngineClient({ tenant_id, actor_id, actor_type: "user", db });
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
    ...(permission_mode ? { permission_mode } : {}),
  };
  const principal: ResolvedPrincipal = {
    provider: "test",
    kind: "user",
    id: actor_id,
    tenant_id,
    roles: ["admin"],
  };
  const tools = await buildExternalMcpTools({
    db,
    principal,
    ctx: toolCtx,
    signals: freshSignals(),
    events,
  });
  return (name: string) => (tools[name] as unknown as { execute: Exec }).execute;
}

describe("external MCP tool — operator trust", () => {
  test("a listed tool runs without the pause and its audit row names the rule", async () => {
    const before = remoteCallToolCalls;
    const run = await palette();
    const result = await run("mcp_examplemcp__search_items")({ q: "x" });
    const data = result.data as Record<string, unknown>;
    expect(data.pending).toBeUndefined();
    expect(data.status).toBe("succeeded");
    expect(remoteCallToolCalls).toBe(before + 1);
    const rows = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, "mcp_external_tool.invoked"),
          eq(auditLog.resource_id, connector_id),
        ),
      );
    const last = rows.at(-1)?.metadata as Record<string, unknown>;
    expect(last.remote_tool).toBe("search_items");
    expect(last.gate_rule).toBe("connector_trust");
  });

  test("an unlisted tool of the same server still pauses", async () => {
    const before = remoteCallToolCalls;
    const run = await palette();
    const result = await run("mcp_examplemcp__create_page")({ title: "t" });
    const data = result.data as Record<string, unknown>;
    expect(data.pending).toBe(true);
    expect(data.status).toBe("awaiting_confirmation");
    expect(remoteCallToolCalls).toBe(before);
  });

  test("permission_mode plan still pauses the listed tool", async () => {
    const before = remoteCallToolCalls;
    const run = await palette("plan");
    const result = await run("mcp_examplemcp__search_items")({ q: "x" });
    const data = result.data as Record<string, unknown>;
    expect(data.pending).toBe(true);
    expect(remoteCallToolCalls).toBe(before);
  });

  test("revoking the grant makes the tool pause on the next call", async () => {
    await setMcpToolConfirmation(ctx.db, {
      tenant_id,
      connector_id,
      tool: "search_items",
      confirm: true,
      actor_id: null,
    });
    const before = remoteCallToolCalls;
    const run = await palette();
    const result = await run("mcp_examplemcp__search_items")({ q: "x" });
    expect((result.data as Record<string, unknown>).pending).toBe(true);
    expect(remoteCallToolCalls).toBe(before);
  });
});
