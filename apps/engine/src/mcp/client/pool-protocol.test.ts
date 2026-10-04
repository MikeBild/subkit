import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { closeDb } from "../../db/client.ts";
import { auditLog, connectorMcpSessions, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { CLIENT_CAPABILITIES } from "./negotiation.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  getTenantMcpTools,
  invokeRemoteTool,
  type McpClientLike,
  type ServerCapabilitiesLike,
} from "./pool.ts";
import { getMcpConnector, parkMcpConnectorFailure, recordMcpHandshakeState } from "./registry.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

interface FakeState {
  capabilities: ServerCapabilitiesLike | undefined;
  protocolVersion: string | null;
  pages: Array<{ tools: unknown[]; nextCursor?: string }>;
  callTool: () => Promise<Record<string, unknown>>;
  closes: number;
  listToolsCalls: number;
  readResourceCalls: number;
}

let state: FakeState;

function freshState(): FakeState {
  return {
    capabilities: { tools: {} },
    protocolVersion: null,
    pages: [
      {
        tools: [
          {
            name: "search",
            description: "finds things",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    ],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    closes: 0,
    listToolsCalls: 0,
    readResourceCalls: 0,
  };
}

const fakeClient: McpClientLike = {
  async connect(transport) {
    if (state.protocolVersion !== null) transport.setProtocolVersion?.(state.protocolVersion);
  },
  async listTools(params) {
    const idx = params?.cursor !== undefined ? Number(params.cursor) : 0;
    state.listToolsCalls += 1;
    return state.pages[idx] ?? { tools: [] };
  },
  async callTool() {
    return state.callTool();
  },
  async readResource() {
    state.readResourceCalls += 1;
    return { contents: [{ uri: "f:///a", text: "res" }] };
  },
  async getPrompt() {
    return { messages: [] };
  },
  getServerCapabilities() {
    return state.capabilities;
  },
  getServerVersion() {
    return { name: "fake-remote", version: "9.9" };
  },
  getInstructions() {
    return "read the wiki first";
  },
  async close() {
    state.closes += 1;
  },
};

let ctx: TestDb;
let tenantId: string;
let serverId: string;
const _origDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createTestDb("mcp-pool-protocol");
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-pool-protocol", display_name: "Pool Protocol Tenant" })
    .returning();
  tenantId = t!.id;
  const server = await seedMcpConnector(ctx.db, {
    tenant_id: tenantId,
    slug: "protofix",
    transport: "http",
    url: "https://protofix.example.test/mcp",
    auth: { kind: "none" },
  });
  serverId = server.id;
}, 30_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (_origDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = _origDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

beforeEach(() => {
  state = freshState();
  __resetMcpClientPoolForTests();
});

function invoke(overrides: Partial<Parameters<typeof invokeRemoteTool>[0]> = {}) {
  return invokeRemoteTool({
    db: ctx.db,
    tenant_id: tenantId,
    actor_id: null,
    connector_id: serverId,
    connector_slug: "protofix",
    call: { operation: "call_tool", tool: "search", arguments: {} },
    environment: "prod",
    ...overrides,
  });
}

describe("structuredContent passthrough", () => {
  test("the typed half arrives verbatim, alongside content rather than merged into it", async () => {
    const typed = { hits: 3, items: [{ id: "a", nested: { deep: true } }] };
    state.callTool = async () => ({
      content: [{ type: "text", text: "3 hits" }],
      structuredContent: typed,
    });
    const res = await invoke();
    expect(res.ok).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: "3 hits" }]);
    expect(res.structured_content).toEqual(typed);
  });

  test("a reply with no structured half carries no key at all", async () => {
    const res = await invoke();
    expect(res.ok).toBe(true);
    expect("structured_content" in res).toBe(false);
  });

  test("the audit row records that a typed half arrived", async () => {
    state.callTool = async () => ({ content: [], structuredContent: { ok: true } });
    await invoke();
    const rows = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "mcp_external_tool.invoked"),
          eq(auditLog.resource_id, serverId),
        ),
      );
    const meta = rows.at(-1)!.metadata as Record<string, unknown>;
    expect(meta.structured).toBe(true);
    expect(meta.advertised_side_effect).toBe("read");
  });
});

describe("an McpError is the remote answering, not the socket dying", () => {
  test("structured output failing its own schema is a remote_error and evicts nothing", async () => {
    state.callTool = async () => {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Structured content does not match the tool's output schema: /items/0/code must be <= 401",
      );
    };
    await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    const closesBefore = state.closes;
    const res = await invoke();
    expect(res.ok).toBe(false);
    expect(res.failure).toBe("remote_error");
    expect(state.closes).toBe(closesBefore);
    const listsBefore = state.listToolsCalls;
    await invoke();
    expect(state.listToolsCalls).toBe(listsBefore);
  });

  test("a closed connection IS a transport failure and does evict", async () => {
    state.callTool = async () => {
      throw new McpError(ErrorCode.ConnectionClosed, "connection closed");
    };
    await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    const closesBefore = state.closes;
    const res = await invoke();
    expect(res.failure).toBe("transport");
    expect(state.closes).toBeGreaterThan(closesBefore);
  });
});

describe("capabilities", () => {
  test("what the server declared is carried out of the pool", async () => {
    state.capabilities = { tools: {}, resources: {}, prompts: {} };
    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(sets[0]?.capabilities).toEqual({ tools: true, resources: true, prompts: true });
    expect(sets[0]?.instructions).toBe("read the wiki first");
  });

  test("an undeclared capability is answered, not attempted", async () => {
    state.capabilities = { tools: {} };
    const res = await invoke({ call: { operation: "read_resource", uri: "f:///a" } });
    expect(res.ok).toBe(false);
    expect(res.failure).toBe("remote_error");
    expect(state.readResourceCalls).toBe(0);
  });

  test("a client that cannot be asked is treated as having declared nothing", async () => {
    const silent: McpClientLike = {
      async connect() {},
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return { content: [] };
      },
      async readResource() {
        return { contents: [] };
      },
      async getPrompt() {
        return { messages: [] };
      },
      async close() {},
    };
    __setMcpPoolFactoriesForTests({ makeClient: () => silent });
    __resetMcpClientPoolForTests();
    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(sets[0]?.capabilities).toBeNull();
    __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  });
});

describe("cancellation", () => {
  test("an aborted call is neither a transport failure nor a torn-down session", async () => {
    const controller = new AbortController();
    state.callTool = async () => {
      controller.abort();
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };
    await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    const closesBefore = state.closes;
    const res = await invoke({ signal: controller.signal });
    expect(res.failure).toBe("cancelled");
    expect(state.closes).toBe(closesBefore);
  });

  test("a cancelled call is audited as cancelled, not as an error", async () => {
    const controller = new AbortController();
    state.callTool = async () => {
      controller.abort();
      throw new Error("aborted");
    };
    await invoke({ signal: controller.signal });
    const rows = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "mcp_external_tool.invoked"),
          eq(auditLog.resource_id, serverId),
        ),
      );
    expect((rows.at(-1)!.metadata as Record<string, unknown>).outcome).toBe("cancelled");
  });
});

describe("tools/list pagination", () => {
  test("every page is followed", async () => {
    state.pages = [
      { tools: [{ name: "one", inputSchema: { type: "object" } }], nextCursor: "1" },
      { tools: [{ name: "two", inputSchema: { type: "object" } }], nextCursor: "2" },
      { tools: [{ name: "three", inputSchema: { type: "object" } }] },
    ];
    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(sets[0]?.tools.map((t) => t.name)).toEqual(["one", "two", "three"]);
  });

  test("a server that never stops paginating is cut off at the bound", async () => {
    state.pages = Array.from({ length: 20 }, (_, i) => ({
      tools: [{ name: `t${i}`, inputSchema: { type: "object" } }],
      nextCursor: String(i + 1),
    }));
    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(state.listToolsCalls).toBe(5);
    expect(sets[0]?.tools).toHaveLength(5);
  });
});

describe("negotiated protocol version", () => {
  async function persistedProtocolVersion(): Promise<string | null> {
    const [row] = await ctx.db
      .select({ version: connectorMcpSessions.negotiated_protocol_version })
      .from(connectorMcpSessions)
      .where(eq(connectorMcpSessions.connector_id, serverId));
    return row?.version ?? null;
  }

  test("what the two sides agreed on is persisted verbatim", async () => {
    state.protocolVersion = "2025-06-18";
    await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(await persistedProtocolVersion()).toBe("2025-06-18");
  });

  test("a session that reported none leaves the column NULL, and re-handshaking overwrites", async () => {
    state.protocolVersion = "2025-06-18";
    await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(await persistedProtocolVersion()).toBe("2025-06-18");

    state.protocolVersion = null;
    __resetMcpClientPoolForTests();
    await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    expect(await persistedProtocolVersion()).toBeNull();
  });
});

describe("persisted handshake backoff", () => {
  test("a window armed before a restart still skips the server; a success clears it", async () => {
    const row = await getMcpConnector(ctx.db, tenantId, serverId);
    if (!row) throw new Error("projection failed");
    await parkMcpConnectorFailure(
      ctx.db,
      row,
      "handshake failed",
      () => new Date(Date.now() + 300_000), // allow-wall-clock
    );

    __resetMcpClientPoolForTests();
    const listsBefore = state.listToolsCalls;
    expect(await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" })).toEqual([]);
    expect(state.listToolsCalls).toBe(listsBefore);

    await recordMcpHandshakeState(ctx.db, row, "v2:cleared");
    __resetMcpClientPoolForTests();
    expect(await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" })).toHaveLength(1);
  });
});

describe("client capabilities", () => {
  test("we declare nothing, because we serve nothing", () => {
    expect(CLIENT_CAPABILITIES).toEqual({});
  });
});
