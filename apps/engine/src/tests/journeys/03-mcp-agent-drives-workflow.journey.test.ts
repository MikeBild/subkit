// User story: As an AI agent, I want to discover workflows and resources
// over the Model Context Protocol and run a workflow inline, so that
// agents can automate against the engine without bespoke glue.
// Acceptance criteria:
//   - AC1: An MCP client that connects over Streamable HTTP can list
//          tools and see the seeded workflow.
//   - AC2: `tools/call` runs the workflow through the engine and returns
//          a parseable result.
//   - AC3: `resources/read` on a `connector://<id>` URI returns the
//          connector metadata.
// Spec refs: docs/03-input-surfaces.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { count, eq } from "drizzle-orm";
import { executions } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let mock: Server;
let mockBase = "";
let workflowSlug = "";
let workflowId = "";
let connectorId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("mcp-agent");

  mock = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify({ hello: "world", ts: 42 }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const addr = mock.address() as AddressInfo;
  mockBase = `http://127.0.0.1:${addr.port}`;

  // Seed a connector so the agent can `resources/read` it.
  const createConn = await journeyFetch(ctx, "/v1/connectors", {
    method: "POST",
    body: JSON.stringify({
      name: "Echo",
      slug: "echo",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mockBase,
    }),
  });
  connectorId = ((await createConn.json()) as { id: string }).id;

  // Seed a workflow.
  workflowSlug = "mcp-probe";
  const createWf = await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "MCP probe",
      slug: workflowSlug,
      steps: [
        {
          kind: "request",
          id: "echo",
          method: "GET",
          url: `${mockBase}/anything`,
        },
      ],
    }),
  });
  workflowId = ((await createWf.json()) as { id: string }).id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

async function connect(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ctx.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${ctx.apiKey}` } },
  });
  const client = new Client({ name: "subkit-journey", version: "0.0.0" });
  await client.connect(transport as unknown as Transport);
  return client;
}

describe("journey: MCP agent drives workflow", () => {
  test("AC1: tools/list surfaces the seeded workflow", async () => {
    const client = await connect();
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain(`wf.${workflowSlug}`);
    } finally {
      await client.close();
    }
  });

  test("AC2: tools/call runs the workflow and returns parseable JSON", async () => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: `wf.${workflowSlug}`,
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(content[0]!.text) as { hello: string };
      expect(parsed.hello).toBe("world");

      const rows = await ctx.db
        .select({ c: count() })
        .from(executions)
        .where(eq(executions.workflow_id, workflowId));
      expect(rows[0]?.c).toBeGreaterThanOrEqual(1);
    } finally {
      await client.close();
    }
  });

  test("AC3: resources/read on connector URI returns metadata", async () => {
    const client = await connect();
    try {
      const list = await client.listResources();
      const uris = list.resources.map((r) => r.uri);
      expect(uris).toContain(`connector://${connectorId}`);

      const read = await client.readResource({ uri: `connector://${connectorId}` });
      const content = read.contents[0] as { text?: string };
      const payload = JSON.parse(content.text!) as { id: string; driver: string };
      expect(payload.id).toBe(connectorId);
      expect(payload.driver).toBe("http");
    } finally {
      await client.close();
    }
  });
});
