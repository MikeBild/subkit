import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("tools-list");
});

afterAll(async () => {
  await suite.cleanup();
});

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

describe("mcp tools/list", () => {
  test("every tool name matches the MCP name pattern ^[a-zA-Z0-9_-]{1,64}$", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.name).toMatch(TOOL_NAME_PATTERN);
    }
  });

  test("exposes workflows with input schemas", async () => {
    await suite.seedWorkflow({
      name: "list probe",
      slug: "list-probe",
      description: "a tiny probe",
      input_schema: {
        type: "object",
        properties: { who: { type: "string" } },
        required: ["who"],
      },
      steps: [
        {
          kind: "transform",
          id: "echo",
          expression: "$input",
        },
      ],
    });

    const client = await suite.connect();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("wf_list-probe");
    const tool = result.tools.find((t) => t.name === "wf_list-probe");
    expect(tool?.description).toBe("a tiny probe");
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: { who: { type: "string" } },
      required: ["who"],
    });
  });
});
