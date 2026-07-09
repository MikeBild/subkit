// Integration coverage for the `find_tool` catalog meta-tool over the REAL
// MCP transport — the real registry, the real dispatcher, the real
// tools/list budget fit. Companion to the pure-logic unit test at
// `../tools/find-tool.test.ts` (fake registry, ranking/shape pins).
//
// This file pins the contract `catalog-budget.ts` rests on: `tools/list`
// is trimmed to a token budget, so the long tail (`call_connector`,
// `dry_run_transform`, the inventory reads) is no longer ADVERTISED — but
// `find_tool` keeps it DISCOVERABLE, and every hit it returns must be
// directly callable via `tools/call`.
//
// We force authoring MCP mode via SK_MCP_MODE (same convention as
// tools-list-disabled.test.ts / self-healing-scan.test.ts) so the default
// test api key doesn't need an `mcp:authoring` scope appended.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FIND_TOOL_TOOL_NAME } from "../tools/find-tool.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let prevMode: string | undefined;

beforeAll(async () => {
  prevMode = process.env.SK_MCP_MODE;
  process.env.SK_MCP_MODE = "authoring";
  suite = await startMcpTestSuite("find-tool");
});

afterAll(async () => {
  await suite.cleanup();
  if (prevMode === undefined) delete process.env.SK_MCP_MODE;
  else process.env.SK_MCP_MODE = prevMode;
});

interface FindToolPayload {
  query: string;
  total_matches: number;
  note: string;
  tools: Array<{ name: string; category: string; summary: string; inputSchema?: unknown }>;
}

async function callFindTool(query: string, limit?: number) {
  const client = await suite.connect();
  const result = await client.callTool({
    name: FIND_TOOL_TOOL_NAME,
    arguments: { query, ...(limit !== undefined ? { limit } : {}) },
  });
  const content = result.content as Array<{ type: string; text: string }>;
  const payload = JSON.parse(content[0]?.text ?? "{}") as FindToolPayload;
  return { isError: result.isError ?? false, payload };
}

describe("find_tool — advertised on the real tools/list", () => {
  test("find_tool appears in the authoring tools/list with a tiny published schema", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === FIND_TOOL_TOOL_NAME);
    expect(tool).toBeDefined();
    // Same ~4 chars/token estimate the budget fit uses (catalog-budget.ts).
    // The whole point of find_tool is that ITS OWN advertised footprint is
    // small enough that budget pressure can never be the reason it gets
    // trimmed — so pin a generous ceiling well under the ~5000-token budget.
    const estTokens = Math.ceil(JSON.stringify(tool).length / 4);
    expect(estTokens).toBeLessThan(400);
  });
});

describe("find_tool — discovers the long tail by keyword", () => {
  test('find_tool("connector") surfaces call_connector, each hit is {name, category, summary} only', async () => {
    const { isError, payload } = await callFindTool("connector");
    expect(isError).toBe(false);
    const names = payload.tools.map((t) => t.name);
    expect(names).toContain("call_connector");
    // find_tool itself is never a hit of itself, and this MUST be a
    // superset of what tools/list advertised for the tail to actually be
    // "the long tail" — call_connector is not in AUTHORING_READ_TOOL_NAMES.
    expect(names).not.toContain(FIND_TOOL_TOOL_NAME);
    for (const hit of payload.tools) {
      expect(hit).not.toHaveProperty("inputSchema");
      expect(Object.keys(hit).sort()).toEqual(["category", "name", "summary"]);
    }
    // The note is what tells the model every hit is directly callable —
    // discovery only works if the model knows it doesn't need a second
    // dispatch step.
    expect(payload.note).toContain("tools/call");
  });

  test('find_tool("nonsense-xyzzy") returns an empty hit list without error', async () => {
    const { isError, payload } = await callFindTool("nonsense-xyzzy");
    expect(isError).toBe(false);
    expect(payload.total_matches).toBe(0);
    expect(payload.tools).toEqual([]);
  });
});

describe("find_tool — discovery -> call actually works", () => {
  test("a long-tail read tool found via find_tool resolves through tools/call by name", async () => {
    // `list_skills` is a tenant_read, no-argument conversation tool that is
    // NOT in AUTHORING_READ_TOOL_NAMES (catalog-budget.ts) — i.e. exactly
    // the kind of tail tool tools/list omits in authoring mode but find_tool
    // must still surface and hand back callable.
    const { isError, payload } = await callFindTool("list skills");
    expect(isError).toBe(false);
    expect(payload.tools.map((t) => t.name)).toContain("list_skills");

    const client = await suite.connect();
    const callResult = await client.callTool({ name: "list_skills", arguments: {} });
    expect(callResult.isError ?? false).toBe(false);
    const content = callResult.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0]?.text ?? "{}") as { skills: unknown[] };
    expect(Array.isArray(data.skills)).toBe(true);
  });

  test("get_engine_status resolves through tools/call (already-advertised sibling of the same contract)", async () => {
    const client = await suite.connect();
    const callResult = await client.callTool({ name: "get_engine_status", arguments: {} });
    expect(callResult.isError ?? false).toBe(false);
    const content = callResult.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThan(0);
  });
});
