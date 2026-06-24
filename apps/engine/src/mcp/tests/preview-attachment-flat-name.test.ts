// preview_attachment surfaces under its bare name via the unified
// registry — the canonical (and now only) MCP surface. The legacy
// `tenant_preview_attachment` alias was removed (it was a pure duplicate
// of the bare name that doubled the catalog).
//
// We force authoring MCP mode so the conversation tool surfaces in
// the catalog (in product mode it's gated by the PRODUCT_MODE_ALLOW_LIST).

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
  test("includes 'preview_attachment' as a bare name", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const names = new Set(result.tools.map((t) => t.name));
    expect(names.has("preview_attachment")).toBe(true);
  });

  test("does NOT include the removed 'tenant_preview_attachment' alias", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const names = new Set(result.tools.map((t) => t.name));
    expect(names.has("tenant_preview_attachment")).toBe(false);
  });

  test("carries the _meta.subkit.category so clients can route", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const bare = result.tools.find((t) => t.name === "preview_attachment");
    expect(bare).toBeDefined();
    const meta = (bare as Record<string, unknown>)._meta as
      | { subkit?: { category?: string } }
      | undefined;
    expect(meta?.subkit?.category).toBe("tenant_read");
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
