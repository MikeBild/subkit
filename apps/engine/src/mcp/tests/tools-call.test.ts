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
      name: "wf_call-probe",
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

  // Affordance regression guard: when a workflow tool result exceeds
  // MCP_OFFLOAD_CHAR_CAP (20 KB), the engine MUST return a native
  // `resource_link` content block so MCP clients can auto-fetch the
  // body via `resources/read`. The previous text-encoded JSON envelope
  // forced LLM agents to parse a URI out of a string field, which they
  // rarely did — an agent would get an offloaded large page back as an
  // unreachable pointer until this contract was fixed.
  test("offloads large results as a resource_link content block (not a text envelope)", async () => {
    // Build a payload that will reliably exceed MCP_OFFLOAD_CHAR_CAP (20 KB).
    const big = "x".repeat(30_000);
    const bigMock = await createMockServer((_req, res) => {
      jsonResponse(res, 200, { blob: big });
    });
    try {
      const wf = await suite.seedWorkflow({
        name: "call offload",
        slug: "call-offload",
        steps: [
          {
            kind: "request",
            id: "u",
            method: "GET",
            url: `${bigMock.baseUrl}/big`,
          },
        ],
      });
      const client = await suite.connect();
      const result = await client.callTool({
        name: "wf_call-offload",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<Record<string, unknown>>;

      // Exactly two blocks: a brief text summary, then the resource_link.
      expect(content.length).toBe(2);
      const textBlock = content[0] as { type: string; text: string };
      expect(textBlock.type).toBe("text");
      expect(textBlock.text).toMatch(/offloaded/i);

      const link = content[1] as {
        type: string;
        uri: string;
        name: string;
        mimeType?: string;
        size?: number;
        description?: string;
      };
      expect(link.type).toBe("resource_link");
      expect(link.uri).toMatch(/^(fixture|s3):\/\//);
      expect(link.name).toContain("call-offload"); // wf_call-offload
      expect(link.mimeType).toBe("application/json");
      expect(typeof link.size).toBe("number");
      expect((link.size ?? 0) > 30_000).toBe(true);

      // Round-trip: read the resource and confirm the body is intact.
      if (link.uri.startsWith("fixture://")) {
        const read = await client.readResource({ uri: link.uri });
        expect(read.contents.length).toBe(1);
        const body = JSON.parse((read.contents[0] as { text: string }).text) as { blob: string };
        expect(body.blob.length).toBe(big.length);
      }

      // Executions row was materialized.
      const rows = await suite.http.db
        .select({ c: count() })
        .from(executions)
        .where(eq(executions.workflow_id, wf.id));
      expect(rows[0]?.c).toBeGreaterThanOrEqual(1);
    } finally {
      await bigMock.close();
    }
  });

  test("maps structured workflow parameters through the workflow tool surface", async () => {
    await suite.seedWorkflow({
      name: "call input probe",
      slug: "call-input-probe",
      input_schema: {
        type: "object",
        required: ["date"],
        properties: {
          date: { type: "string" },
        },
      },
      steps: [
        {
          kind: "transform",
          id: "shape",
          expression: "return input.input.date;",
          language: "javascript",
        },
      ],
    });
    const client = await suite.connect();
    const result = await client.callTool({
      name: "wf_call-input-probe",
      arguments: {
        date: "tomorrow +1",
      },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBe(1);
    expect(JSON.parse(content[0]!.text)).toBe("tomorrow +1");
  });
});
