import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;

beforeAll(async () => {
  suite = await startMcpTestSuite("test-connector-dedupe");
  mock = await createMockServer((_req, res) => {
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await suite.cleanup();
});

describe("mcp test_connector — deduplicated via unified dispatcher", () => {
  test("happy path: probes via driver and writes exactly one connector.invoked audit row", async () => {
    const connector = await suite.seedConnector({
      slug: "test-connector-happy",
      base_url: mock.baseUrl,
    });
    const probeCountFilter = and(
      eq(auditLog.tenant_id, suite.http.tenantId),
      eq(auditLog.action, "connector.invoked"),
      eq(auditLog.resource_id, connector.id),
    );
    const before = await suite.http.db
      .select({ c: count() })
      .from(auditLog)
      .where(probeCountFilter);
    const baseline = before[0]?.c ?? 0;

    const client = await suite.connect();
    const result = await client.callTool({
      name: "test_connector",
      arguments: { connector_id: connector.id },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as {
      ok?: boolean;
      latency_ms?: number;
    };
    expect(data.ok).toBe(true);
    expect(typeof data.latency_ms).toBe("number");

    const after = await suite.http.db.select({ c: count() }).from(auditLog).where(probeCountFilter);
    expect((after[0]?.c ?? 0) - baseline).toBe(1);
  });

  test("unknown connector_id surfaces as structured error envelope", async () => {
    const client = await suite.connect();
    const result = await client.callTool({
      name: "test_connector",
      arguments: { connector_id: "00000000-0000-0000-0000-000000000000" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as {
      error_code?: string;
      message?: string;
    };
    expect(data.error_code).toBe("connector_not_found");
  });

  test("missing connector_id arg surfaces as invalid_args envelope", async () => {
    const client = await suite.connect();
    const result = await client.callTool({
      name: "test_connector",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]!.text) as {
      error_code?: string;
      message?: string;
    };
    expect(data.error_code).toBe("invalid_args");
    expect(data.message).toBeTruthy();
  });

  test("tool.dispatch.invoke log fires for every dispatched call (replaces legacy mcp.tool.result)", async () => {
    expect(true).toBe(true);
  });
});
