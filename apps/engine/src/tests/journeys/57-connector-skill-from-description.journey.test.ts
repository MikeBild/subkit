// User story: As an operator, I want a connector I authored from a plain
// description in chat to come with a skill proposal that tells the model how
// to navigate the server, so that a later conversation does not answer "there
// are no tables" while the server lists them behind a data path.
// Acceptance criteria:
//   - AC1: Authoring an MCP connector from a description, then probing it
//          green, auto-saves the connector.
//   - AC2: The save proposes exactly one connector-scoped skill candidate
//          bound to the new connector. Its body names the data paths and the
//          paging hints the server's own tool descriptions carry.
//   - AC3: The candidate is a decision: reviewable, and counted where
//          pending skill candidates are surfaced (`/v1/attention`).
//   - AC4: Approving it through the approval route loads the promoted skill
//          into the context of a conversation that uses the connector.
//   - AC5: Probing the unchanged server again does not add a second
//          candidate.
// Spec refs: docs/concepts/knowledge-and-skills.md, docs/concepts/connectors.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assembleEnhancedPrompt } from "../../llm/core/context-assembler.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../mcp/client/pool.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

// The tool catalog of a real Metabase MCP server, as `tools/list` returned it.
const METABASE_TOOLS = [
  {
    name: "read_resource",
    description:
      "Read Metabase entities by metabase:// URI. Examples: metabase://databases, metabase://database/{id}/tables, metabase://collection/{id}/items, metabase://question/{id}, metabase://dashboard/{id}/items, metabase://table/{id}/fields. Up to 5 URIs per call. List endpoints cap at 25 items.",
    inputSchema: {
      type: "object",
      properties: { uris: { type: "array", items: { type: "string", minLength: 1 } } },
      required: ["uris"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search",
    description:
      'Search for tables, models, metrics, saved questions, dashboards, and collections in Metabase. Use term_queries for keyword search or semantic_queries for natural language search. Both arguments are arrays of strings, for example term_queries: ["orders", "revenue"].',
    inputSchema: {
      type: "object",
      properties: { term_queries: {}, semantic_queries: {} },
      required: ["term_queries", "semantic_queries"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "execute_sql",
    description:
      "Execute a raw SQL query against a Metabase-connected database. Use this ONLY when MBQL via construct_query cannot express the question. User must have native-query permission on the target database. Standard userspace query limits apply.",
    inputSchema: {
      type: "object",
      properties: { database_id: { type: "integer", minimum: 1 }, sql: { type: "string" } },
      required: ["database_id", "sql"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "query",
    description:
      "Execute a Metabase query and return results with column metadata, paginating automatically up to 2,000 rows total.\n\nResults are returned in pages of 200 rows. When more pages remain within the 2,000-row budget, the response includes a continuation_token — pass it back to fetch the next page.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_question",
    description:
      "Save a query as a named question in Metabase. Pass the `query_handle` returned by `construct_query` (MBQL) or `construct_native_query` (native SQL).",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
    annotations: { readOnlyHint: false },
  },
];

const METABASE_INSTRUCTIONS =
  "Start with read_resource metabase://databases to find the database id, then list its tables.";

let ctx: JourneyCtx;
let handshakes = 0;

function fakeMetabaseClient(): McpClientLike {
  return {
    async connect() {
      handshakes += 1;
    },
    async listTools() {
      return { tools: METABASE_TOOLS };
    },
    getInstructions() {
      return METABASE_INSTRUCTIONS;
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
  };
}

beforeAll(async () => {
  ctx = await createJourneyCtx("connector-skill");
  __setMcpPoolFactoriesForTests({
    makeClient: () => fakeMetabaseClient(),
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
  scope: string;
  connector_id: string | null;
  status: string;
  reviewable?: boolean;
  review_digest?: string;
  title: string;
  body: string;
}

async function listConnectorCandidates(connectorId: string): Promise<CandidateItem[]> {
  const res = await journeyFetch(
    ctx,
    `/v1/skill-candidates?scope=connector&connector_id=${connectorId}`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: CandidateItem[] }).items;
}

async function authorAndProbe(): Promise<{ connectorId: string | null; events: unknown[] }> {
  const createRes = await journeyFetch(ctx, "/v1/conversations", {
    method: "POST",
    body: JSON.stringify({}),
  });
  expect(createRes.status).toBe(201);
  const conversationId = ((await createRes.json()) as { conversation: { id: string } }).conversation
    .id;
  getMockProvider().setConversePlan(conversationId, [
    {
      tool: "start_connector_from_description",
      args: {
        name: "metabase-reporting-mcp",
        description: "Metabase reporting over MCP: databases, tables and saved questions.",
        driver: "mcp",
        environment: "prod",
        base_url: "https://metabase.journey.invalid/api/mcp",
        auth_type: "none",
      },
    },
    { tool: "validate_connector_draft", args: {} },
    { tool: "probe_connector_draft", args: {} },
  ]);
  const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message: "Connect our Metabase MCP server for reporting" }),
  });
  expect([200, 202]).toContain(res.status);
  const body = (await res.json()) as {
    events: Array<{ type: string; tool?: string; output?: unknown }>;
  };
  const probe = body.events.find(
    (e) => e.type === "tool_result" && e.tool === "probe_connector_draft",
  );
  const output = (probe?.output ?? {}) as { auto_saved?: boolean; connector?: { id?: string } };
  return {
    connectorId: output.auto_saved === true ? (output.connector?.id ?? null) : null,
    events: body.events,
  };
}

describe("journey: connector authored from a description proposes its skill", () => {
  let connectorId: string;
  let candidate: CandidateItem;
  let skillId: string;

  test("AC1: description → green probe auto-saves the MCP connector", async () => {
    const out = await authorAndProbe();
    if (!out.connectorId) {
      throw new Error(`probe did not auto-save: ${JSON.stringify(out.events).slice(0, 2000)}`);
    }
    connectorId = out.connectorId;
    expect(handshakes).toBeGreaterThan(0);
  });

  test("AC2: one connector-scoped candidate names the data paths and paging", async () => {
    const items = await listConnectorCandidates(connectorId);
    expect(items).toHaveLength(1);
    candidate = items[0]!;
    expect(candidate).toMatchObject({
      scope: "connector",
      connector_id: connectorId,
      status: "proposed",
    });
    expect(candidate.body).toContain("metabase://databases");
    expect(candidate.body).toContain("metabase://database/{id}/tables");
    expect(candidate.body).toContain("cap at 25 items");
    expect(candidate.body).toContain("read_resource");
    expect(candidate.body).toContain("metabase.journey.invalid");
  });

  test("AC3: the candidate is a pending decision surfaced in attention", async () => {
    expect(candidate.reviewable).toBe(true);
    const res = await journeyFetch(ctx, "/v1/attention");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("skill_candidates");
  });

  test("AC4: approving loads the skill into a conversation using the connector", async () => {
    const res = await journeyFetch(ctx, `/v1/skill-candidates/${candidate.id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        status: "active",
        ...(candidate.review_digest ? { expected_review_digest: candidate.review_digest } : {}),
      }),
    });
    expect(res.status).toBe(200);
    skillId = ((await res.json()) as { skill_id: string }).skill_id;

    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id: ctx.tenantId,
        flow: "converse",
        connector_id: connectorId,
        user_turns: [{ role: "user", content: "Which databases are there?" }],
        max_tokens: 200_000,
      },
      ctx.db,
    );
    expect(prompt.included_skill_ids).toContain(skillId);
  });

  test("AC5: probing the unchanged server again adds no candidate", async () => {
    const out = await authorAndProbe();
    const id = out.connectorId ?? connectorId;
    const items = await listConnectorCandidates(id);
    expect(items.filter((c) => c.status === "proposed")).toHaveLength(0);
    expect(items).toHaveLength(1);
  });
});
