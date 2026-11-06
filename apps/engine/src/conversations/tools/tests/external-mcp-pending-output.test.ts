import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { closeDb, type Db } from "../../../db/client.ts";
import { conversations } from "../../../db/schema/index.ts";
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
import { freshSignals } from "../../tests/turn-signals.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { buildExternalMcpTools } from "../sdk-wrap/external-mcp-tools.ts";

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

let ctx: TestDb;
let tenant_id: string;
let actor_id: string;
let conversation_id: string;
const _origDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createTestDb("external-mcp-pending-output");
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  tenant_id = (
    await seedTenant(ctx.db, { slug: "t-mcp-pending", display_name: "MCP Pending Output" })
  ).id;
  actor_id = createDeterministicUuidFactory(319)();
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = conv!.id;

  await seedMcpConnector(ctx.db, {
    tenant_id,
    slug: "examplemcp",
    transport: "http",
    url: "https://examplemcp.pendingtest.example.com/mcp",
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

describe("external MCP tool confirm envelope", () => {
  test("pending output carries input_keys, never input values", async () => {
    __resetMcpClientPoolForTests();
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

    const tools = await buildExternalMcpTools({
      db,
      principal,
      ctx: toolCtx,
      signals: freshSignals(),
      events,
    });
    const toolName = "mcp_examplemcp__create_page";
    expect(Object.keys(tools)).toContain(toolName);

    const SENSITIVE_TITLE = "Customer ACME quarterly numbers";
    const SENSITIVE_BODY = "internal-secret-figure-42";
    const execute = (
      tools[toolName] as unknown as {
        execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; data: unknown }>;
      }
    ).execute;
    const result = await execute({ title: SENSITIVE_TITLE, body: SENSITIVE_BODY });

    const data = result.data as Record<string, unknown>;
    expect(data.pending).toBe(true);
    expect(data.status).toBe("awaiting_confirmation");

    expect(data.pending_output).toEqual({
      connector_slug: "examplemcp",
      remote_tool: "create_page",
      input_keys: ["body", "title"],
    });

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(SENSITIVE_TITLE);
    expect(serialized).not.toContain(SENSITIVE_BODY);

    expect(remoteCallToolCalls).toBe(0);
  });
});
