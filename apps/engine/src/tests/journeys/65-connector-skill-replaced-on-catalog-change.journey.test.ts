import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../mcp/client/pool.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const BASE_TOOLS = [
  {
    name: "read_resource",
    description:
      "Read entities by reporting:// URI. Examples: reporting://databases, reporting://database/{id}/tables.",
    inputSchema: { type: "object", properties: { uris: { type: "array" } } },
    annotations: { readOnlyHint: true },
  },
];

let catalog: Array<Record<string, unknown>> = [...BASE_TOOLS];

function fakeClient(): McpClientLike {
  return {
    async connect() {},
    async listTools() {
      return { tools: catalog };
    },
    getInstructions() {
      return undefined;
    },
    async callTool() {
      return { content: [], isError: false };
    },
    async readResource() {
      return { contents: [] };
    },
    async getPrompt() {
      return { messages: [] };
    },
    async close() {},
  } as McpClientLike;
}

let ctx: JourneyCtx;

beforeAll(async () => {
  ctx = await createJourneyCtx("connector-skill-replaced");
  __setMcpPoolFactoriesForTests({
    makeClient: () => fakeClient(),
    makeTransport: () => ({}) as never,
  });
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

interface CandidateItem {
  id: string;
  status: string;
  review_digest?: string;
  body: string;
}

interface SkillItem {
  id: string;
  status: string;
}

async function listCandidates(connectorId: string): Promise<CandidateItem[]> {
  const res = await journeyFetch(
    ctx,
    `/v1/skill-candidates?scope=connector&connector_id=${connectorId}`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: CandidateItem[] }).items;
}

async function listSkills(connectorId: string, status?: string): Promise<SkillItem[]> {
  const res = await journeyFetch(
    ctx,
    `/v1/skills?scope=connector&connector_id=${connectorId}${status ? `&status=${status}` : ""}`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: SkillItem[] }).items;
}

async function approve(candidate: CandidateItem, status: "active" | "draft"): Promise<string> {
  const res = await journeyFetch(ctx, `/v1/skill-candidates/${candidate.id}/approve`, {
    method: "POST",
    body: JSON.stringify({
      status,
      ...(candidate.review_digest ? { expected_review_digest: candidate.review_digest } : {}),
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { skill_id: string }).skill_id;
}

async function turn(
  conversationId: string,
  plan: Array<{ tool: string; args: Record<string, unknown> }>,
  message: string,
): Promise<string | null> {
  getMockProvider().setConversePlan(conversationId, plan);
  const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  expect([200, 202]).toContain(res.status);
  const body = (await res.json()) as {
    events: Array<{ type: string; tool?: string; output?: unknown }>;
  };
  const probe = body.events.find(
    (e) => e.type === "tool_result" && e.tool === "probe_connector_draft",
  );
  const output = (probe?.output ?? {}) as { auto_saved?: boolean; connector?: { id?: string } };
  return output.auto_saved === true ? (output.connector?.id ?? null) : null;
}

async function changeCatalogAndReprobe(extraTool: string): Promise<void> {
  catalog = [
    ...catalog,
    {
      name: extraTool,
      description: `Run the ${extraTool} operation.`,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ];
  __resetMcpClientPoolForTests();
  const again = await turn(
    conversationId,
    [{ tool: "probe_connector_draft", args: {} }],
    "Check the reporting connection again",
  );
  expect(again).toBe(connectorId);
}

async function archivedAuditRows(skillId: string) {
  return ctx.db
    .select({ actor_id: auditLog.actor_id, actor_type: auditLog.actor_type })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, "skill.archived"),
        eq(auditLog.resource_id, skillId),
      ),
    );
}

let conversationId = "";
let connectorId = "";

describe("journey: a changed MCP catalog replaces the connector skill", () => {
  let v1Skill = "";
  let v2Skill = "";

  test("AC1: the first skill is approved; a changed catalog proposes a second", async () => {
    const created = await journeyFetch(ctx, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    conversationId = ((await created.json()) as { conversation: { id: string } }).conversation.id;
    const saved = await turn(
      conversationId,
      [
        {
          tool: "start_connector_from_description",
          args: {
            name: "reporting-mcp",
            description: "Reporting over MCP: databases and tables.",
            driver: "mcp",
            environment: "prod",
            base_url: "https://reporting.journey.invalid/api/mcp",
            auth_type: "none",
          },
        },
        { tool: "validate_connector_draft", args: {} },
        { tool: "probe_connector_draft", args: {} },
      ],
      "Connect our reporting MCP server",
    );
    if (!saved) throw new Error("probe did not auto-save the connector");
    connectorId = saved;

    const [first] = await listCandidates(connectorId);
    if (!first) throw new Error("no connector skill candidate proposed");
    v1Skill = await approve(first, "active");
    expect((await listSkills(connectorId, "active")).map((s) => s.id)).toEqual([v1Skill]);

    await changeCatalogAndReprobe("export_table");
    const items = await listCandidates(connectorId);
    expect(items.map((c) => c.status).sort()).toEqual(["approved", "proposed"]);
    expect(items.find((c) => c.status === "proposed")?.body).toContain("export_table");
  });

  test("AC2: approving the new one active leaves exactly one active skill", async () => {
    const next = (await listCandidates(connectorId)).find((c) => c.status === "proposed");
    if (!next) throw new Error("no proposed candidate");
    v2Skill = await approve(next, "active");

    const active = await listSkills(connectorId, "active");
    expect(active.map((s) => s.id)).toEqual([v2Skill]);
    const all = await listSkills(connectorId);
    expect(all.find((s) => s.id === v1Skill)?.status).toBe("archived");

    const rows = await archivedAuditRows(v1Skill);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "user", actor_id: ctx.userId });
    const created = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "skill.created"),
          eq(auditLog.resource_id, v2Skill),
        ),
      );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actor_type: "user", actor_id: ctx.userId });
  });

  test("AC3: a draft approval keeps the active skill; activating it replaces it", async () => {
    await changeCatalogAndReprobe("run_report");
    const next = (await listCandidates(connectorId)).find((c) => c.status === "proposed");
    if (!next) throw new Error("no proposed candidate");
    const v3Skill = await approve(next, "draft");
    expect((await listSkills(connectorId, "active")).map((s) => s.id)).toEqual([v2Skill]);

    const res = await journeyFetch(ctx, `/v1/skills/${v3Skill}/activate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await listSkills(connectorId, "active")).map((s) => s.id)).toEqual([v3Skill]);
    expect(await archivedAuditRows(v2Skill)).toHaveLength(1);
  });
});
