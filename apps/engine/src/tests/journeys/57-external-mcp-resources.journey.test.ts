// User story: As an operator who connected a reporting server over MCP,
// I ask the chat which databases exist and which tables one of them has,
// and the model answers from the server — it can see the server's own
// tools, its resource templates, and the guidance the server ships.
// Acceptance criteria:
//   - AC1: a remote TOOL the server names `read_resource` reaches the model
//          with the server's own description, and calling it issues
//          `tools/call` on that tool — never `resources/read`. An
//          engine-minted adapter must not take a name the server already
//          uses.
//   - AC2: the server's resource templates are reachable: a
//          `list_resource_templates` entry is offered and, once a person
//          approves it, returns the server's templates.
//   - AC3: the server's `instructions` reach the model, attributed to the
//          server as its own words.
// Spec refs: docs/developers/tool-palette.md
//
// The remote is a REAL SDK `McpServer` on an in-memory transport, swapped
// in through the pool's transport seam; the engine's real SDK `Client`
// negotiates with it. The model is the mock provider, which records the
// palette it was offered — the only place "reaches the model" can be
// checked, since every layer between assembly and the provider call has
// had its say by then.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setMcpToolConfirmation } from "../../connectors/mcp-tool-trust.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  __resetMcpClientPoolForTests,
  __setMcpPoolFactoriesForTests,
} from "../../mcp/client/pool.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const SERVER_INSTRUCTIONS =
  "Start with the metabase://databases resource to see every database, then read metabase://database/{id}/tables for one database.";
const TEMPLATE = "metabase://database/{id}/tables";

let ctx: JourneyCtx;
let remoteToolCalls: string[] = [];
let resourceReads: string[] = [];

/** A fresh server per handshake: an `McpServer` connects exactly once. */
function reportingServer(): McpServer {
  const server = new McpServer(
    { name: "reporting", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  server.registerTool(
    "read_resource",
    {
      description:
        "Read a reporting resource. Use metabase://databases to list every database and metabase://database/{id}/tables to list the tables of one.",
      inputSchema: { uri: z.string() },
    },
    async ({ uri }) => {
      remoteToolCalls.push(uri);
      return { content: [{ type: "text", text: `databases: CM-Prod (id 1), Analytics (id 2)` }] };
    },
  );
  server.registerResource(
    "guide",
    "metabase://docs/guide",
    { mimeType: "text/markdown" },
    async (uri) => {
      resourceReads.push(uri.href);
      return { contents: [{ uri: uri.href, text: "# Guide" }] };
    },
  );
  server.registerResource(
    "database-tables",
    new ResourceTemplate(TEMPLATE, { list: undefined }),
    { mimeType: "application/json" },
    async (uri) => {
      resourceReads.push(uri.href);
      return { contents: [{ uri: uri.href, text: "[]" }] };
    },
  );
  return server;
}

interface TurnBody {
  status?: string;
  events: Array<{
    type: string;
    tool?: string;
    output?: Record<string, unknown>;
    elicitation_id?: string;
  }>;
}

async function newConversation(): Promise<string> {
  const res = await journeyFetch(ctx, "/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ permission_mode: "ask" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { conversation: { id: string } }).conversation.id;
}

async function say(conversationId: string, message: string): Promise<TurnBody> {
  const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  expect([200, 202]).toContain(res.status);
  return (await res.json()) as TurnBody;
}

function lastPalette(): Array<{ name: string; description: string }> {
  const palettes = getMockProvider().toolPalettes;
  return palettes[palettes.length - 1] ?? [];
}

beforeAll(async () => {
  ctx = await createJourneyCtx("external-mcp-resources");
  __setMcpPoolFactoriesForTests({
    makeTransport: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void reportingServer().connect(serverSide);
      return clientSide;
    },
  });
  const seeded = await seedMcpConnector(ctx.db, {
    tenant_id: ctx.tenantId,
    slug: "metabase",
    display_name: "Metabase",
    transport: "http",
    url: "https://metabase.journey.example.com/mcp",
  });
  // The operator lets the server's own `read_resource` tool run without a
  // question — the setting that exists for exactly this kind of read.
  await setMcpToolConfirmation(ctx.db, {
    tenant_id: ctx.tenantId,
    connector_id: seeded.id,
    tool: "read_resource",
    confirm: false,
    actor_id: null,
  });
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  __setMcpPoolFactoriesForTests(null);
  __resetMcpClientPoolForTests();
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 57: a connected MCP server's resources reach the model", () => {
  test(
    "AC1: the server's own read_resource tool is what the model sees and what runs",
    async () => {
      remoteToolCalls = [];
      resourceReads = [];
      const conversationId = await newConversation();
      getMockProvider().setConversePlan(conversationId, [
        { tool: "mcp_metabase__read_resource", args: { uri: "metabase://databases" } },
      ]);
      const turn = await say(conversationId, "Welche Datenbanken gibt es?");

      const entry = lastPalette().find((t) => t.name === "mcp_metabase__read_resource");
      expect(entry?.description).toContain("metabase://databases");

      const result = turn.events.find(
        (e) => e.type === "tool_result" && e.tool === "mcp_metabase__read_resource",
      );
      expect(result?.output?.remote_tool).toBe("read_resource");
      expect(result?.output?.status).toBe("succeeded");
      expect(remoteToolCalls).toEqual(["metabase://databases"]);
      expect(resourceReads).toEqual([]);
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test(
    "AC2: resource templates are listed, and an approved call returns them",
    async () => {
      const conversationId = await newConversation();
      getMockProvider().setConversePlan(conversationId, [
        { tool: "mcp_metabase__list_resource_templates", args: {} },
      ]);
      const paused = await say(conversationId, "Welche Tabellen hat CM-Prod?");
      expect(lastPalette().map((t) => t.name)).toContain("mcp_metabase__list_resource_templates");

      // A read the engine minted still asks, like every other adapter.
      const pause = paused.events.find(
        (e) => e.type === "tool_result" && e.tool === "mcp_metabase__list_resource_templates",
      );
      expect(pause?.output?.status).toBe("awaiting_confirmation");
      const confirmId = pause?.output?.confirm_id as string;
      const elicitationId = paused.events.find((e) => e.type === "elicit_request")?.elicitation_id;
      expect(typeof elicitationId).toBe("string");

      const respond = await journeyFetch(
        ctx,
        `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`,
        { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
      );
      expect(respond.status).toBe(200);

      getMockProvider().setConversePlan(conversationId, [
        {
          tool: "mcp_metabase__list_resource_templates",
          args: { __policy_confirmed: true, __policy_confirm_id: confirmId },
        },
      ]);
      const ran = await say(conversationId, "Weiter.");
      const result = ran.events.find(
        (e) =>
          e.type === "tool_result" &&
          e.tool === "mcp_metabase__list_resource_templates" &&
          e.output?.status === "succeeded",
      );
      const content = result?.output?.content as
        | { resource_templates?: Array<{ uriTemplate?: string }> }
        | undefined;
      expect(content?.resource_templates?.map((t) => t.uriTemplate)).toEqual([TEMPLATE]);
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test(
    "AC3: the server's instructions reach the model, attributed to the server",
    async () => {
      const conversationId = await newConversation();
      await say(conversationId, "Was kann der Metabase-Server?");
      const carrying = lastPalette().filter((t) => t.description.includes(SERVER_INSTRUCTIONS));
      expect(carrying.map((t) => t.name)).toHaveLength(1);
      expect(carrying[0]?.name.startsWith("mcp_metabase__")).toBe(true);
      expect(carrying[0]?.description).toContain("not verified by SubKit");
    },
    JOURNEY_HOOK_TIMEOUT,
  );
});
