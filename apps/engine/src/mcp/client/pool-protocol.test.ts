// The outbound protocol claims, driven through the real pool.
//
// INJECTION PATTERN: the pool's documented TEST SEAM
// (`__setMcpPoolFactoriesForTests`) swaps the SDK Client construction for
// an in-process fake — NO bun `mock.module` (module mocks are
// process-global and leak into every other test file in the same worker).
//
// The claims under test, each of which was previously either absent or
// actively wrong:
//
//   1. `structuredContent` reaches the caller VERBATIM and SEPARATE from
//      `content`. It is the half the SDK validated against the tool's own
//      declared output schema; merging them loses which half carried the
//      guarantee, and dropping it — which is what happened — loses the
//      entire payload of any tool that declares an output schema, because
//      the SDK will not accept such a reply without one.
//
//   2. AN `McpError` IS NOT A DEAD SOCKET. The SDK raises one from inside
//      `callTool` when structured output fails the tool's schema. Read as
//      a transport failure it evicted a healthy pooled session, armed
//      backoff, and — because the 401 detector matches the digit sequence
//      401 anywhere in a message — would delete the server's OAuth token
//      if the validator's complaint happened to mention it.
//
//   3. A capability the server never declared is answered, not attempted.
//      The SDK asserts capabilities by THROWING a plain Error, which the
//      pool would have read as the socket dying.
//
//   4. Cancelling a call does not tear down the session other calls share.
//
//   5. `tools/list` pagination is followed, and bounded.
//
//   6. Client capabilities are declared as EMPTY: we serve no sampling, no
//      roots, no elicitation, so we invite none.
//
//   7. The NEGOTIATED protocol version is persisted. The SDK never hands it
//      to the Client — only to the transport — so the column it belongs in
//      was written NULL on every handshake, which made the schema claim
//      something the code did not do.
//
//   8. A backoff window armed before a restart still holds. The window the
//      pool keeps in memory dies with the process; the persisted one is
//      what stops a server that has been refusing for an hour from being
//      re-tried at full rate the moment the engine bounces.

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
  /** What the fake tells the TRANSPORT it negotiated, exactly where the
   *  real SDK Client reports it. `null` = never reported. */
  protocolVersion: string | null;
  /** Pages returned by `tools/list`, in order. */
  pages: Array<{ tools: unknown[]; nextCursor?: string }>;
  /** What `callTool` does. */
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
    // Where the real SDK Client reports the negotiated version: it hands
    // it to the transport from inside `initialize`, never to itself.
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
    // Verbatim: same shape, no coercion, no truncation in the pool.
    expect(res.structured_content).toEqual(typed);
  });

  test("a reply with no structured half carries no key at all", async () => {
    // An absent key and a key holding `undefined` read the same in memory
    // but not through the persisted tool-call row, and `get_raw_result`
    // reads that row.
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
    // And what the SERVER claimed about the tool, next to how it was
    // treated — the fixture annotates `search` as read-only while the
    // engine gates every tools/call as a write.
    expect(meta.advertised_side_effect).toBe("read");
  });
});

describe("an McpError is the remote answering, not the socket dying", () => {
  test("structured output failing its own schema is a remote_error and evicts nothing", async () => {
    // This is the exact message shape the SDK raises from inside callTool,
    // carrying a `401` the old 401-detector would have matched.
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
    // The session was healthy and stays open.
    expect(state.closes).toBe(closesBefore);
    // And it is still pooled: a second call reuses it rather than
    // re-handshaking.
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
    // The fixture declares tools only. A resources/read must come back as
    // the remote's answer about the call — and must never reach the
    // client, where the SDK's own assertion would throw a plain Error the
    // pool reads as a dead socket.
    state.capabilities = { tools: {} };
    const res = await invoke({ call: { operation: "read_resource", uri: "f:///a" } });
    expect(res.ok).toBe(false);
    expect(res.failure).toBe("remote_error");
    // Never reached the client at all: the SDK's own capability assertion
    // throws a plain Error, and that would have been read as a dead socket.
    expect(state.readResourceCalls).toBe(0);
  });

  test("a client that cannot be asked is treated as having declared nothing", async () => {
    // Conservative direction: nothing is minted off an unanswered
    // question, and nothing is refused off one either.
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
    // The pooled Client is shared by every call in the tenant. Evicting it
    // because ONE caller walked away would cold-start every sibling.
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
    // Following without a bound turns a looping or hostile server into an
    // unbounded read inside the handshake, which stalls the turn that
    // triggered it.
    state.pages = Array.from({ length: 20 }, (_, i) => ({
      tools: [{ name: `t${i}`, inputSchema: { type: "object" } }],
      nextCursor: String(i + 1),
    }));
    const sets = await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" });
    // Default bound is 5 pages; the manifest read so far is kept, because
    // a partial palette beats no palette.
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
    // Written on EVERY handshake, so the column answers "what did the last
    // session negotiate" rather than "what did the first one". And a
    // session that never reported a version is not backfilled with the one
    // we PROPOSED: that is a different claim, and a column that answers a
    // question nobody asked is worse than an empty one.
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
    // `consecutive_failures` and `backoff_until` are only worth the columns
    // they occupy if a fresh process actually honours them — the in-memory
    // window dies with the process, and re-trying a server that has been
    // refusing for an hour at full rate is what persisting them prevents.
    const row = await getMcpConnector(ctx.db, tenantId, serverId);
    if (!row) throw new Error("projection failed");
    await parkMcpConnectorFailure(
      ctx.db,
      row,
      "handshake failed",
      () => new Date(Date.now() + 300_000), // allow-wall-clock
    );

    // A fresh process: no in-memory window anywhere.
    __resetMcpClientPoolForTests();
    const listsBefore = state.listToolsCalls;
    expect(await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" })).toEqual([]);
    // Skipped, not attempted-and-failed.
    expect(state.listToolsCalls).toBe(listsBefore);

    // And the window is not permanent: a successful handshake clears both
    // columns, so the next turn connects.
    await recordMcpHandshakeState(ctx.db, row, "v2:cleared");
    __resetMcpClientPoolForTests();
    expect(await getTenantMcpTools(ctx.db, tenantId, { environment: "prod" })).toHaveLength(1);
  });
});

describe("client capabilities", () => {
  test("we declare nothing, because we serve nothing", () => {
    // A declared client capability is an invitation. `sampling` invites
    // `sampling/createMessage`; `elicitation` invites a question aimed at
    // a human through a channel we do not operate; `roots` invites a
    // request for a filesystem we do not have. None is implemented, so
    // none is advertised — the advertisement-without-fulfilment failure
    // this repo has already paid for once on the inbound side.
    expect(CLIENT_CAPABILITIES).toEqual({});
  });
});
