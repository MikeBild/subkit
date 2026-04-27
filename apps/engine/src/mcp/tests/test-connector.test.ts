// `test_connector` MCP tool — driver health probe against a saved
// connector by id. Mirrors POST /v1/connectors/:id/test.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { createMockServer, type MockServer } from "../../execution/tests/setup.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;

beforeAll(async () => {
  suite = await startMcpTestSuite("test-connector");
  mock = await createMockServer((req, res) => {
    if (req.method === "HEAD" || req.method === "GET") {
      res.statusCode = 200;
      res.end();
      return;
    }
    res.statusCode = 405;
    res.end();
  });
});

afterAll(async () => {
  await mock.close();
  await suite.cleanup();
});

describe("mcp test_connector", () => {
  test("returns ok=true and audit row for a healthy HTTP connector", async () => {
    const cn = await suite.seedConnector({
      slug: "healthy",
      display_name: "Healthy Connector",
      driver: "http",
      base_url: mock.baseUrl,
    });

    const client = await suite.connect();
    const result = await client.callTool({
      name: "test_connector",
      arguments: { connector_id: cn.id },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as {
      connector_id: string;
      slug: string;
      driver: string;
      ok: boolean;
      latency_ms: number;
    };
    expect(data.connector_id).toBe(cn.id);
    expect(data.slug).toBe("healthy");
    expect(data.driver).toBe("http");
    expect(data.ok).toBe(true);
    expect(data.latency_ms).toBeGreaterThanOrEqual(0);

    // The probe must land an audit row routed through the same
    // recordConnectorInvoked recorder that the HTTP / converse surfaces use.
    const rows = await suite.http.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, suite.http.tenantId),
          eq(auditLog.action, "connector.invoked"),
          eq(auditLog.resource_id, cn.id),
        ),
      )
      .orderBy(desc(auditLog.ts))
      .limit(1);
    expect(rows.length).toBe(1);
    const meta = rows[0]?.metadata as Record<string, unknown>;
    expect(meta.method).toBe("PROBE");
    expect(meta.driver).toBe("http");
  });

  test("rejects unknown connector_id with connector_not_found", async () => {
    const client = await suite.connect();
    const result = await client.callTool({
      name: "test_connector",
      arguments: { connector_id: "00000000-0000-0000-0000-000000000000" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as { error: string };
    expect(data.error).toBe("connector_not_found");
  });

  test("rejects missing connector_id arg with input validation error", async () => {
    const client = await suite.connect();
    const result = await client.callTool({
      name: "test_connector",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as { error: string };
    expect(data.error).toBe("connector_id is required");
  });
});
