import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createEmptyDraftDocument,
  withLatestPreview,
  withWorkflowInspection,
} from "../../conversations/authoring-state/index.ts";
import { appendSnapshot } from "../../conversations/draft.ts";
import {
  conversationElicitations,
  conversations,
  workflowExecutionAuthorities,
} from "../../db/schema/index.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
  type McpClientLike,
} from "../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { mcpToolDescriptorPin } from "../../workflows/mcp-boundary.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let connectorId: string;
let sequence = 0;

const SEARCH = {
  name: "search",
  description: "search the index",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const PIN = mcpToolDescriptorPin(SEARCH);
const remote = { tools: [SEARCH] as Array<Record<string, unknown>> };

const fakeClient: McpClientLike = {
  async connect() {},
  async listTools() {
    return { tools: remote.tools };
  },
  async callTool() {
    return { content: [], isError: false };
  },
  async readResource(params) {
    return { contents: [{ uri: params.uri, text: "" }] };
  },
  async getPrompt() {
    return { messages: [] };
  },
  async close() {},
};

beforeAll(async () => {
  __setMcpPoolFactoriesForTests({ makeClient: () => fakeClient });
  srv = await createHttpTestServer("conversation-workflow-reviews-tool-pins");
  const server = await seedMcpConnector(srv.db, {
    tenant_id: srv.tenantId,
    slug: "reviewtools",
    display_name: "Review tools",
    environment: "prod",
    transport: "http",
    url: "https://tools.reviewpins.example.com/mcp",
  });
  connectorId = server.id;
}, 30_000);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  await srv?.cleanup();
}, 30_000);

async function prepared(descriptor: Record<string, unknown>) {
  const slug = `reviewed-tool-call-${++sequence}`;
  const [conversation] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, owner_id: srv.userId, status: "awaiting_input" })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("conversation fixture missing");
  await appendSnapshot(
    srv.tenantId,
    conversation.id,
    withLatestPreview(
      withWorkflowInspection({
        ...createEmptyDraftDocument("workflow_authoring"),
        workflow: {
          name: slug,
          slug,
          steps: [
            {
              id: "lookup",
              kind: "request",
              protocol: "mcp",
              connector_id: connectorId,
              mcp: {
                operation: "call_tool",
                tool: "search",
                arguments: { q: "${input.q}" },
                boundary: {
                  effect: "read",
                  variables: { "input.q": { enum: ["alpha"] } },
                  max_calls: 1,
                  descriptor,
                },
              },
            },
          ],
        },
      }),
      { ok: true, summary: "synthetic held preview" },
    ),
    srv.db,
  );
  const [elicitation] = await srv.db
    .insert(conversationElicitations)
    .values({
      tenant_id: srv.tenantId,
      conversation_id: conversation.id,
      tool_name: "ask_user_confirm",
      summary: "Save and activate the reviewed draft",
      input: { question: "Save and activate?", commit_intent: { kind: "save_workflow_draft" } },
      status: "pending",
    })
    .returning({ id: conversationElicitations.id });
  if (!elicitation) throw new Error("elicitation fixture missing");
  const headers = await browserSessionHeaders(srv, srv.userId);
  const path = `/v1/conversations/${conversation.id}/workflow-reviews`;
  const now = getTestNow();
  const response = await fetch(`${srv.baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      elicitation_id: elicitation.id,
      activate: true,
      grant: {
        environment: "prod",
        valid_from: new Date(now - 60_000).toISOString(),
        valid_until: new Date(now + 86_400_000).toISOString(),
        max_runs: 3,
      },
      schedule: null,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const receipt = (await response.json()) as { receipt_id: string; snapshot_digest: string };
  return {
    finalize: () =>
      fetch(`${srv.baseUrl}${path}/${receipt.receipt_id}/finalize`, {
        method: "POST",
        headers,
        body: JSON.stringify({ expected_snapshot_digest: receipt.snapshot_digest }),
      }),
  };
}

const authorities = () =>
  srv.db
    .select({ id: workflowExecutionAuthorities.id })
    .from(workflowExecutionAuthorities)
    .where(and(eq(workflowExecutionAuthorities.tenant_id, srv.tenantId)));

test("finalizing a review whose tool pin does not match the server is a 409 refusal and grants nothing", async () => {
  const before = (await authorities()).length;
  const review = await prepared({
    input_schema_digest: "f".repeat(64),
    annotations: PIN.annotations,
  });
  const response = await review.finalize();
  expect(response.status, await response.clone().text()).toBe(409);
  expect((await response.json()).code).toBe("mcp_tool_changed");
  expect((await authorities()).length).toBe(before);
});

test("a tool the server no longer lists is a 409 refusal too", async () => {
  const review = await prepared({
    input_schema_digest: PIN.input_schema_digest,
    annotations: PIN.annotations,
  });
  remote.tools = [];
  const response = await review.finalize();
  remote.tools = [SEARCH];
  expect(response.status, await response.clone().text()).toBe(409);
  expect((await response.json()).code).toBe("mcp_tool_unavailable");
});

test("a matching pin is compared on a fresh tool list and the approval is written", async () => {
  const before = (await authorities()).length;
  const review = await prepared({
    input_schema_digest: PIN.input_schema_digest,
    annotations: PIN.annotations,
  });
  const response = await review.finalize();
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await authorities()).length).toBe(before + 1);
});
