// preview_attachment is reachable under its bare name via the unified
// registry — the canonical (and now only) MCP surface. The legacy
// `tenant_preview_attachment` alias was removed (it was a pure duplicate
// of the bare name that doubled the catalog).
//
// It IS published in the authoring `tools/list`: the catalog no longer trims —
// it advertises the full authoring set and lets the client's native
// tool-search/defer-loading handle size. So this suite asserts both catalog
// membership (bare name advertised, no legacy alias) and the CALL contract.

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
    // Advertised now: the full authoring catalog publishes every registry tool.
    expect(names.has("preview_attachment")).toBe(true);
    // The removed duplicate alias never comes back under any mode.
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
    // Either succeeds with not-found-shaped data (ok:true with empty
    // result) or fails with structured error_code. Both shapes are
    // allowed by the contract — we assert the response is well-formed,
    // not 500.
    expect(typeof result.isError).toBe("boolean");
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThanOrEqual(1);
    expect(() => JSON.parse(content[0]!.text)).not.toThrow();
  });
});
