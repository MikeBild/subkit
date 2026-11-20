import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { setMcpToolConfirmation } from "../../../connectors/mcp-tool-trust.ts";
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
import { decideToolMode, taskRunToolPolicies } from "../../tool-policies.ts";
import type { TaskRunMarker, TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { buildExternalMcpTools } from "../sdk-wrap/external-mcp-tools.ts";
import { taskRunAllowsWebSearch } from "../sdk-wrap/task-run-guard.ts";

let remoteCalls = 0;

const fakeClient: McpClientLike = {
  async connect() {},
  async listTools() {
    return {
      tools: [
        {
          name: "search_items",
          description: "Search items on the remote server",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  },
  async callTool() {
    remoteCalls += 1;
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
let bound_id: string;
let unbound_id: string;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalMasterKey = process.env.MASTER_KEY;

function marker(overrides: Partial<TaskRunMarker> = {}): TaskRunMarker {
  return {
    task_id: "44444444-5555-4666-8777-888888888888",
    task_run_id: "55555555-6666-4777-8888-999999999999",
    environment: "dev",
    workflow_ids: [],
    connector_ids: [bound_id],
    web_search: false,
    ...overrides,
  };
}

beforeAll(async () => {
  process.env.MASTER_KEY = "a".repeat(64);
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  ctx = await createTestDb("task-run-external-mcp");
  await closeDb();
  process.env.DATABASE_URL = ctx.url;
  tenant_id = (await seedTenant(ctx.db, { slug: "t-run-mcp", display_name: "Run MCP" })).id;
  actor_id = createDeterministicUuidFactory(911)();
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = conv!.id;
  bound_id = (
    await seedMcpConnector(ctx.db, {
      tenant_id,
      slug: "boundmcp",
      transport: "http",
      url: "https://boundmcp.runtest.example.com/mcp",
    })
  ).id;
  unbound_id = (
    await seedMcpConnector(ctx.db, {
      tenant_id,
      slug: "othermcp",
      transport: "http",
      url: "https://othermcp.runtest.example.com/mcp",
    })
  ).id;
  for (const connector_id of [bound_id, unbound_id])
    await setMcpToolConfirmation(ctx.db, {
      tenant_id,
      connector_id,
      tool: "search_items",
      confirm: false,
      actor_id: null,
    });
}, 60_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await closeDb();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalMasterKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = originalMasterKey;
  await ctx.cleanup();
}, 60_000);

type Exec = (input: Record<string, unknown>) => Promise<{ ok: boolean; data: unknown }>;

async function palette(taskRun: TaskRunMarker | null, viaContext = false) {
  __resetMcpClientPoolForTests();
  const events: TurnEvent[] = [];
  const db = ctx.db as unknown as Db;
  const toolCtx: ToolContext = {
    db,
    tenant_id,
    conversation_id,
    actor_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id, actor_type: "user", db }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
    ...(viaContext && taskRun ? { task_run: taskRun } : {}),
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
    ...(!viaContext && taskRun ? { taskRun } : {}),
  });
  return {
    names: Object.keys(tools).sort(),
    run: (name: string) => (tools[name] as unknown as { execute: Exec }).execute({}),
  };
}

function toolName(names: string[], slug: string): string {
  const name = names.find((candidate) => candidate.includes(slug));
  if (!name) throw new Error(`no tool for ${slug} in ${names.join(",")}`);
  return name;
}

describe("external MCP tools in a task run", () => {
  test("an ordinary conversation offers both servers and runs a trusted tool without asking", async () => {
    const ordinary = await palette(null);
    expect(ordinary.names.some((name) => name.includes("boundmcp"))).toBe(true);
    expect(ordinary.names.some((name) => name.includes("othermcp"))).toBe(true);
    const before = remoteCalls;
    const result = await ordinary.run(toolName(ordinary.names, "boundmcp"));
    expect(result.ok).toBe(true);
    expect(remoteCalls).toBe(before + 1);
  }, 60_000);

  test("a task run offers only the bound server, also when the marker comes from the turn", async () => {
    for (const viaContext of [false, true]) {
      const run = await palette(marker(), viaContext);
      expect(run.names.length).toBeGreaterThan(0);
      expect(run.names.every((name) => name.includes("boundmcp"))).toBe(true);
    }
    expect((await palette(marker({ connector_ids: [] }))).names).toEqual([]);
    expect((await palette({ ...marker(), sealed: true })).names).toEqual([]);
  }, 60_000);

  test("a tool the operator trusts still asks first in a task run", async () => {
    const run = await palette(marker());
    const before = remoteCalls;
    const result = await run.run(toolName(run.names, "boundmcp"));
    expect(result.ok).toBe(false);
    expect(remoteCalls).toBe(before);
    expect(JSON.stringify(result.data)).toMatch(/pending|awaiting|confirm/i);
  }, 60_000);
});

describe("policy and web search for a task run", () => {
  test("connector trust and no-confirm overrides do not lower confirmation", () => {
    const base = {
      tool: "mcp_boundmcp_search_items",
      category: "tenant_write" as const,
      input: {},
      overrides: {},
      permission_mode: "auto" as const,
      connector_trust: true,
    };
    expect(decideToolMode(base)).toEqual({ mode: "no_confirm", rule: "connector_trust" });
    expect(decideToolMode({ ...base, task_run: true }).mode).toBe("confirm_before_execution");
    const save = {
      tool: "save_workflow_draft",
      category: "draft_write" as const,
      input: {},
      overrides: { save_workflow_draft: "no_confirm" as const },
      permission_mode: null,
    };
    expect(decideToolMode(save).mode).toBe("no_confirm");
    expect(decideToolMode({ ...save, task_run: true }).mode).toBe("confirm_before_execution");
    expect(
      taskRunToolPolicies({ a: "no_confirm", b: "confirm_before_execution", c: "no_confirm" }),
    ).toEqual({ b: "confirm_before_execution" });
  });

  test("web search is offered only when the task allows it", () => {
    expect(taskRunAllowsWebSearch(null)).toBe(true);
    expect(taskRunAllowsWebSearch(marker())).toBe(false);
    expect(taskRunAllowsWebSearch(marker({ web_search: true }))).toBe(true);
    expect(taskRunAllowsWebSearch({ ...marker({ web_search: true }), sealed: true })).toBe(false);
  });
});
