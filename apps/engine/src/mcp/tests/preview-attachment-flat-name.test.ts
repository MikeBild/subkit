// preview_attachment surfaces under its bare name (via the unified
// registry) AND under its `tenant_preview_attachment` legacy alias
// (via the prefix proxy in `mcp/capabilities/tenant-tools.ts`). Both
// paths must remain reachable — the bare name is the post-cutover
// canonical, the alias is the backward-compat shim for pre-cutover
// MCP clients.
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

  test("also includes 'tenant_preview_attachment' for backward compat (no breaking change)", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const names = new Set(result.tools.map((t) => t.name));
    expect(names.has("tenant_preview_attachment")).toBe(true);
  });

  test("both names carry the same _meta.subkit.category so clients can dedupe", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const bare = result.tools.find((t) => t.name === "preview_attachment");
    const aliased = result.tools.find((t) => t.name === "tenant_preview_attachment");
    expect(bare).toBeDefined();
    expect(aliased).toBeDefined();
    const bareCategory = (bare as Record<string, unknown>)._meta as
      | { subkit?: { category?: string } }
      | undefined;
    const aliasedCategory = (aliased as Record<string, unknown>)._meta as
      | { subkit?: { category?: string } }
      | undefined;
    expect(bareCategory?.subkit?.category).toBe("tenant_read");
    expect(aliasedCategory?.subkit?.category).toBe("tenant_read");
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

  test("legacy 'tenant_preview_attachment' alias still routes to the conversation tool", async () => {
    const client = await suite.connect();
    const result = await client.callTool({
      name: "tenant_preview_attachment",
      arguments: { slug: "00000000-0000-0000-0000-000000000000", max_chars: 512 },
    });
    // The legacy tenant.* proxy renders ok:false ToolResults as plain
    // text in the response (not JSON-encoded), so we only assert the
    // envelope shape exists and isn't a server crash. The bare-name
    // path emits structured JSON (see test above); the alias kept
    // plain text for backward compat.
    expect(typeof result.isError).toBe("boolean");
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThanOrEqual(1);
    expect(typeof content[0]?.text).toBe("string");
    expect(content[0]?.text.length).toBeGreaterThan(0);
  });
});
