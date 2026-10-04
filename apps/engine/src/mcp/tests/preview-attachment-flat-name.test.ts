import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  process.env.SK_MCP_MODE = "authoring";
  suite = await startMcpTestSuite("preview-attachment-flat-name");
});

afterAll(async () => {
  await suite.cleanup();
  delete process.env.SK_MCP_MODE;
});

describe("mcp tools/list — preview_attachment naming", () => {
  test("is advertised in the full authoring tools/list under its bare name, with no legacy alias", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const names = new Set(result.tools.map((t) => t.name));
    expect(names.has("preview_attachment")).toBe(true);
    expect(names.has("tenant_preview_attachment")).toBe(false);
  });
});

describe("mcp tools/call — preview_attachment routing", () => {
  test("bare 'preview_attachment' for unknown slug returns structured error envelope", async () => {
    const client = await suite.connect();
    const result = await client.callTool({
      name: "preview_attachment",
      arguments: { slug: "00000000-0000-0000-0000-000000000000", max_chars: 512 },
    });
    expect(typeof result.isError).toBe("boolean");
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThanOrEqual(1);
    expect(() => JSON.parse(content[0]!.text)).not.toThrow();
  });
});
