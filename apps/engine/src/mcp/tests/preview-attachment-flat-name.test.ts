// preview_attachment is reachable under its bare name via the unified
// registry — the canonical (and now only) MCP surface. The legacy
// `tenant_preview_attachment` alias was removed (it was a pure duplicate
// of the bare name that doubled the catalog).
//
// It is NOT published in the authoring `tools/list`: the catalog allow-list
// publishes ~24 named tools to fit the schema-token budget, and the long tail
// of inventory reads (preview_attachment among them) stays reachable through
// `tools/call` / `conversation_start` rather than being advertised. So this
// suite asserts the CALL contract (bare name resolves, no legacy alias), not
// catalog membership.

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
  test("is long-tail: not advertised in authoring tools/list, and the legacy alias is gone", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const names = new Set(result.tools.map((t) => t.name));
    // Long-tail inventory read: reachable via tools/call (below), not published.
    expect(names.has("preview_attachment")).toBe(false);
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
