import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { eq } from "drizzle-orm";
import { toolApprovals } from "../../db/schema/index.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  process.env.SK_MCP_MODE = "authoring";
  suite = await startMcpTestSuite("refused-before-approval");
});

afterAll(async () => {
  await suite?.cleanup();
  delete process.env.SK_MCP_MODE;
});

function body(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
    status?: string;
    error_code?: string;
    message?: string;
  };
}

async function approvalCount(): Promise<number> {
  const rows = await suite.http.db
    .select({ id: toolApprovals.id })
    .from(toolApprovals)
    .where(eq(toolApprovals.tenant_id, suite.http.tenantId));
  return rows.length;
}

describe("MCP asks nobody to approve a call that cannot run", () => {
  test("an invented connector is refused without an approval", async () => {
    const client = await suite.connect();
    const before = await approvalCount();
    const result = body(
      await client.callTool({
        name: "call_connector",
        arguments: {
          connector_id: "6f1c2b9e-3d4a-4e5f-8a7b-9c0d1e2f3a4b",
          method: "POST",
          path: "/orders",
          body: { qty: 1 },
        },
      }),
    );
    expect(result.status).not.toBe("needs_confirm");
    expect(result.error_code).toBe("connector_not_found");
    expect(await approvalCount()).toBe(before);
  });

  test("a probe of a connector slug that does not exist is refused without an approval", async () => {
    const client = await suite.connect();
    const before = await approvalCount();
    const result = body(
      await client.callTool({
        name: "probe_connector",
        arguments: {
          connector_slug: "no-such-connector",
          method: "POST",
          path: "/orders",
          environment: "prod",
        },
      }),
    );
    expect(result.status).not.toBe("needs_confirm");
    expect(result.error_code).toBe("connector_not_found");
    expect(await approvalCount()).toBe(before);
  });

  test("a call against a saved connector still waits for the person", async () => {
    await suite.seedConnector({
      slug: "refused-before-approval-live",
      environment: "prod",
      base_url: "https://orders.example.test",
    });
    const client = await suite.connect();
    const before = await approvalCount();
    const result = body(
      await client.callTool({
        name: "probe_connector",
        arguments: {
          connector_slug: "refused-before-approval-live",
          method: "POST",
          path: "/orders",
          environment: "prod",
        },
      }),
    );
    expect(result.status).toBe("needs_confirm");
    expect(await approvalCount()).toBe(before + 1);
  });
});
