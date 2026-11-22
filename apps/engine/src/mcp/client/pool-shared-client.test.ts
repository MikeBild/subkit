import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { closeDb } from "../../db/client.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  invokeRemoteTool,
  type McpClientLike,
} from "./pool.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

interface Pending {
  resolve: (value: { content: unknown[]; isError: boolean }) => void;
  reject: (err: unknown) => void;
}

interface FakeServer {
  connects: number;
  closes: number;
  pending: Map<string, Pending>;
}

const server: FakeServer = { connects: 0, closes: 0, pending: new Map() };

function makeFakeClient(): McpClientLike {
  let closed = false;
  const inFlight = new Set<Pending>();
  return {
    async connect() {
      server.connects += 1;
    },
    async listTools() {
      return {
        tools: [
          { name: "slow", description: "slow", inputSchema: { type: "object", properties: {} } },
          { name: "long", description: "long", inputSchema: { type: "object", properties: {} } },
        ],
      };
    },
    callTool(params) {
      if (closed) return Promise.reject(new McpError(ErrorCode.ConnectionClosed, "closed"));
      return new Promise((resolve, reject) => {
        const entry: Pending = {
          resolve: (value) => {
            inFlight.delete(entry);
            resolve(value);
          },
          reject: (err) => {
            inFlight.delete(entry);
            reject(err);
          },
        };
        inFlight.add(entry);
        server.pending.set(params.name, entry);
      });
    },
    async readResource() {
      return { contents: [] };
    },
    async getPrompt() {
      return { messages: [] };
    },
    async close() {
      closed = true;
      server.closes += 1;
      for (const p of [...inFlight]) {
        p.reject(new McpError(ErrorCode.ConnectionClosed, "Connection closed"));
      }
    },
  } as McpClientLike;
}

async function waitForPending(name: string): Promise<Pending> {
  const pending = await waitFor(() => server.pending.get(name), {
    tries: 400,
    sleepMs: 5,
    label: `call ${name} reaches the server`,
  });
  server.pending.delete(name);
  return pending;
}

let ctx: TestDb;
let tenantId: string;
let connectorId: string;
const _origDatabaseUrl = testEnv.DATABASE_URL;

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => makeFakeClient() });
  ctx = await createTestDb("mcp-pool-shared-client");
  await closeDb();
  testEnv.DATABASE_URL = ctx.url;
  const t = await seedTenant(ctx.db, { slug: "t-pool-shared", display_name: "Pool Shared" });
  tenantId = t.id;
  const row = await seedMcpConnector(ctx.db, {
    tenant_id: tenantId,
    slug: "shared",
    transport: "http",
    url: "https://shared.pooltest.example.com/mcp",
  });
  connectorId = row.id;
}, 30_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (_origDatabaseUrl === undefined) delete testEnv.DATABASE_URL;
  else testEnv.DATABASE_URL = _origDatabaseUrl;
  await ctx.cleanup();
}, 30_000);

beforeEach(() => {
  __resetMcpClientPoolForTests();
  server.connects = 0;
  server.closes = 0;
  server.pending.clear();
});

function call(tool: string) {
  return invokeRemoteTool({
    db: ctx.db,
    tenant_id: tenantId,
    actor_id: null,
    connector_id: connectorId,
    connector_slug: "shared",
    call: { operation: "call_tool", tool, arguments: {} },
    requestSource: "api",
  });
}

describe("pooled MCP client shared by concurrent calls", () => {
  test("a timeout on one call leaves the other call on the same connector running", async () => {
    const long = call("long");
    const longPending = await waitForPending("long");
    const slow = call("slow");
    const slowPending = await waitForPending("slow");

    slowPending.reject(new McpError(ErrorCode.RequestTimeout, "Request timed out"));
    const slowResult = await slow;
    longPending.resolve({ content: [{ type: "text", text: "done" }], isError: false });
    const longResult = await long;

    expect(longResult.ok).toBe(true);
    expect(server.closes).toBe(0);
    expect(slowResult.ok).toBe(false);
    expect(slowResult.failure).toBe("timeout");

    const again = call("long");
    (await waitForPending("long")).resolve({ content: [], isError: false });
    expect((await again).ok).toBe(true);
    expect(server.connects).toBe(1);
  });

  test("a real transport failure retires the client and closes it after its last call", async () => {
    const long = call("long");
    const longPending = await waitForPending("long");
    const slow = call("slow");
    const slowPending = await waitForPending("slow");

    slowPending.reject(new Error("socket hang up"));
    expect((await slow).failure).toBe("transport");
    expect(server.closes).toBe(0);

    longPending.resolve({ content: [], isError: false });
    expect((await long).ok).toBe(true);
    expect(server.closes).toBe(1);

    const again = call("long");
    (await waitForPending("long")).resolve({ content: [], isError: false });
    expect((await again).ok).toBe(true);
    expect(server.connects).toBe(2);
  });
});
