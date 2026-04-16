import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import { executions } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;

beforeAll(async () => {
  suite = await startMcpTestSuite("tools-call");
  mock = await createMockServer((_req, res) => {
    jsonResponse(res, 200, { hello: "world" });
  });
});

afterAll(async () => {
  await mock.close();
  await suite.cleanup();
});

describe("mcp tools/call", () => {
  test("runs the workflow and returns the result", async () => {
    const wf = await suite.seedWorkflow({
      name: "call probe",
      slug: "call-probe",
      steps: [
        {
          kind: "request",
          id: "u",
          method: "GET",
          url: `${mock.baseUrl}/ping`,
        },
      ],
    });
    const client = await suite.connect();
    const result = await client.callTool({
      name: "wf.call-probe",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBe(1);
    const parsed = JSON.parse(content[0]!.text) as { hello: string };
    expect(parsed.hello).toBe("world");

    // An executions row should have been materialized for the tenant.
    const rows = await suite.http.db
      .select({ c: count() })
      .from(executions)
      .where(eq(executions.workflow_id, wf.id));
    expect(rows[0]?.c).toBeGreaterThanOrEqual(1);
  });
});
