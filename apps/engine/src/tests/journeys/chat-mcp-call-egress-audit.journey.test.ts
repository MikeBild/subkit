import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { setMcpToolConfirmation } from "../../connectors/mcp-tool-trust.ts";
import { auditLog } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;
let connectorId = "";
let workflowId = "";
const remoteCalls: string[] = [];

function fakeClient(): McpClientLike {
  return {
    async connect() {},
    async listTools() {
      return {
        tools: [
          {
            name: "search",
            description: "Search reports by keyword.",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    },
    getInstructions() {
      return undefined;
    },
    async callTool(params: { name: string }) {
      remoteCalls.push(`tools/call ${params.name}`);
      return { content: [{ type: "text", text: "3 reports" }], isError: false };
    },
    async readResource(params: { uri: string }) {
      remoteCalls.push(`resources/read ${params.uri}`);
      return { contents: [{ uri: params.uri, text: "report body" }] };
    },
    async getPrompt() {
      return { messages: [] };
    },
    async close() {},
  } as McpClientLike;
}

beforeAll(async () => {
  ctx = await createJourneyCtx("chat-mcp-egress");
  __setMcpPoolFactoriesForTests({
    makeClient: () => fakeClient(),
    makeTransport: () => ({}) as never,
  });
  const seeded = await seedMcpConnector(ctx.db, {
    tenant_id: ctx.tenantId,
    slug: "reports",
    display_name: "Reports",
    transport: "http",
    url: "https://reports.journey.example.com/mcp",
  });
  connectorId = seeded.id;
  await setMcpToolConfirmation(ctx.db, {
    tenant_id: ctx.tenantId,
    connector_id: connectorId,
    tool: "search",
    confirm: false,
    actor_id: null,
  });
  const workflow = await seedWorkflow(ctx, {
    slug: "read-report",
    name: "Read report",
    steps: [
      {
        id: "read",
        kind: "request",
        connector_id: connectorId,
        mcp: { operation: "read_resource", uri: "reports://latest" },
      },
    ],
  });
  workflowId = workflow.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

function egressRows() {
  return ctx.db
    .select({
      actor_id: auditLog.actor_id,
      result: auditLog.result,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, "connector.invoked"),
        eq(auditLog.resource_id, connectorId),
      ),
    );
}

function statsWindow(): string {
  const to = new Date(getTestNow() + 3_600_000);
  const from = new Date(to.getTime() - 4 * 3_600_000);
  return `bucket=hour&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
}

interface StatsBody {
  totals: { calls: { total: number } };
  groups: Array<{ key: Record<string, string>; totals: { calls: { total: number } } }>;
}

async function stats(query: string): Promise<StatsBody> {
  const res = await journeyFetch(ctx, `/v1/stats/connectors?${statsWindow()}&${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as StatsBody;
}

describe("a chat MCP call is egress like a workflow's", () => {
  test("AC1: the chat call leaves the egress row a workflow call leaves", async () => {
    const created = await journeyFetch(ctx, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ permission_mode: "ask" }),
    });
    expect(created.status).toBe(201);
    const conversationId = ((await created.json()) as { conversation: { id: string } }).conversation
      .id;
    getMockProvider().setConversePlan(conversationId, [
      { tool: "mcp_reports__search", args: { q: "invoices" } },
    ]);
    const turn = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: "Find the invoice reports" }),
    });
    expect([200, 202]).toContain(turn.status);
    const events = (
      (await turn.json()) as {
        events: Array<{ type: string; tool?: string; output?: { status?: string } }>;
      }
    ).events;
    const result = events.find((e) => e.type === "tool_result" && e.tool === "mcp_reports__search");
    expect(result?.output?.status).toBe("succeeded");

    const run = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowId }),
    });
    expect(run.status).toBe(200);
    expect(((await run.json()) as { status?: string }).status).toBe("succeeded");
    expect(remoteCalls).toEqual(["tools/call search", "resources/read reports://latest"]);

    const rows = await egressRows();
    const bySource = (source: string) =>
      rows.filter((r) => (r.metadata as Record<string, unknown>).source === source);
    expect(bySource("execution")).toHaveLength(1);
    const chat = bySource("tool");
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ actor_id: ctx.userId, result: "success" });
    expect(chat[0]?.metadata).toMatchObject({
      connector_id: connectorId,
      connector_slug: "reports",
      driver: "mcp",
      operation: "tools/call",
      url_host: "reports.journey.example.com",
    });
  });

  test("AC2: one chat call and one workflow call count as two calls", async () => {
    expect((await stats(`connector_id=${connectorId}`)).totals.calls.total).toBe(2);
    expect((await stats("driver=mcp")).totals.calls.total).toBe(2);
    const grouped = await stats("group_by=connector_id");
    expect(grouped.groups.find((g) => g.key.connector_id === connectorId)?.totals.calls.total).toBe(
      2,
    );
  });

  test("AC3: the runtime read still sees the calls", async () => {
    const res = await journeyFetch(ctx, `/v1/connectors/${connectorId}/runtime`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { last_success_at: string | null; recorded: boolean };
    expect(typeof body.last_success_at).toBe("string");
    expect(body.recorded).toBe(true);
  });
});
