import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let client: Client;
let echo: Server;
let echoBase = "";
let readWorkflowId = "";
let readExecutionId = "";
let heldExecutionId = "";
let connectorId = "";
const hits: string[] = [];

beforeAll(async () => {
  ctx = await createJourneyCtx("core-mcp-client", {
    envOverrides: { MASTER_KEY: "ab".repeat(32) },
  });
  echo = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ order: "A-17", state: "shipped" }));
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
  echoBase = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  const connector = await journeyFetch(ctx, "/v1/connectors", {
    method: "POST",
    body: JSON.stringify({
      name: "Shop",
      slug: "shop",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: echoBase,
    }),
  });
  connectorId = ((await connector.json()) as { id: string }).id;
  const read = await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Order status",
      slug: "order-status",
      description: "Looks up the shipping state of a customer order",
      steps: [{ kind: "request", id: "lookup", method: "GET", url: `${echoBase}/orders/A-17` }],
    }),
  });
  readWorkflowId = ((await read.json()) as { id: string }).id;
  await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Cancel order",
      slug: "cancel-order",
      description: "Cancels a customer order in the shop",
      steps: [
        {
          kind: "request",
          id: "cancel",
          connector_id: connectorId,
          method: "POST",
          path: "/orders/A-17/cancel",
          body: { reason: "customer" },
        },
      ],
    }),
  });
  const transport = new StreamableHTTPClientTransport(new URL(ctx.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${ctx.apiKey}` } },
  });
  client = new Client({ name: "core-journey", version: "0.0.0" });
  await client.connect(transport as unknown as Transport);
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return {
    isError: result.isError === true,
    body: JSON.parse(content[0]?.text ?? "null") as Record<string, unknown>,
  };
}

describe("an MCP client finds, runs and follows a workflow, and an unapproved write is held", () => {
  test("the client sees the finder, the runner and the follower", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["find_workflow", "run_workflow", "get_execution"]),
    );
  });

  test("the client reads the shop connector as a resource", async () => {
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toContain(`connector://${connectorId}`);
    const read = await client.readResource({ uri: `connector://${connectorId}` });
    const payload = JSON.parse((read.contents[0] as { text: string }).text) as {
      id: string;
      driver: string;
    };
    expect(payload).toMatchObject({ id: connectorId, driver: "http" });
  });

  test("find_workflow finds the workflow by what it is for", async () => {
    const found = await call("find_workflow", { query: "shipping state" });
    expect(found.isError).toBe(false);
    const matches = found.body.matches as Array<{ id: string; slug: string; reasons: string[] }>;
    expect(matches.map((m) => m.slug)).toEqual(["order-status"]);
    expect(matches[0]?.id).toBe(readWorkflowId);
    expect(matches[0]?.reasons.some((r) => r.startsWith("description:"))).toBe(true);
  });

  test("run_workflow starts it and hands back the echo result", async () => {
    const ran = await call("run_workflow", { workflow: "order-status" });
    expect(ran.isError).toBe(false);
    expect(ran.body.status).toBe("succeeded");
    expect(ran.body.output).toEqual({ order: "A-17", state: "shipped" });
    readExecutionId = ran.body.execution_id as string;
    expect(readExecutionId).toBeTruthy();
    expect(hits).toContain("GET /orders/A-17");
  });

  test("get_execution follows the run to its succeeded outcome", async () => {
    const followed = await call("get_execution", { id: readExecutionId });
    expect(followed.isError).toBe(false);
    const execution = followed.body.execution as Record<string, unknown>;
    expect(execution.id).toBe(readExecutionId);
    expect(execution.workflow_id).toBe(readWorkflowId);
    expect(execution.status).toBe("succeeded");
    expect((followed.body.outcome as { kind: string }).kind).toBe("succeeded");
  });

  test("a write without execution authority is held, names the human decision and sends nothing", async () => {
    const held = await call("run_workflow", { workflow: "cancel-order" });
    expect(held.body.writes_held).toBe(true);
    expect(held.body.held_step_ids).toEqual(["cancel"]);
    expect(held.body.execution_authority_id).toBeNull();
    expect(String(held.body.writes_held_note)).toContain("execution authority");
    expect(String(held.body.writes_held_note)).toContain("human decision");
    expect(hits.filter((h) => h.startsWith("POST"))).toEqual([]);
    heldExecutionId = held.body.execution_id as string;
    const followed = await call("get_execution", { id: heldExecutionId });
    expect((followed.body.outcome as { kind: string }).kind).toBe("held");
  });
});
