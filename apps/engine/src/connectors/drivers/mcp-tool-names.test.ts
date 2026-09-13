// The `mcp_<slug>__<tool>` grammar, and the collision it exists to prevent.
//
// The whole point of banning `__` inside a connector slug is that the FIRST
// `__` after the prefix is then the only possible split point. These tests
// pin that: two different (slug, tool) pairs must never compose to the same
// name, and every name we compose must round-trip back to the pair it came
// from. Without the ban both properties break, and the visible symptom is a
// tool call landing on the wrong remote server.

import { describe, expect, test } from "bun:test";

import { CONNECTOR_SLUG_RE, ConnectorSlugSchema } from "../types.ts";
import {
  buildMcpToolName,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_NAME_RE,
  McpToolNameError,
  parseMcpToolName,
} from "./mcp.ts";

describe("buildMcpToolName", () => {
  test("composes prefix, slug and remote tool", () => {
    expect(buildMcpToolName("rovo", "search_pages")).toBe("mcp_rovo__search_pages");
  });

  test("the composed name satisfies the tool-name charset", () => {
    expect(MCP_TOOL_NAME_RE.test(buildMcpToolName("rovo", "search_pages"))).toBe(true);
  });

  test("a slug carrying a double underscore is refused, not split on", () => {
    let caught: unknown;
    try {
      buildMcpToolName("legacy__conn", "search");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpToolNameError);
    expect((caught as McpToolNameError).reason).toBe("invalid_slug");
  });

  test("a remote tool name carrying a double underscore is refused", () => {
    expect(() => buildMcpToolName("rovo", "a__b")).toThrow(McpToolNameError);
  });

  test("a remote tool name with a dot is refused — several clients reject dots", () => {
    let caught: unknown;
    try {
      buildMcpToolName("rovo", "jira.search");
    } catch (err) {
      caught = err;
    }
    expect((caught as McpToolNameError).reason).toBe("invalid_remote_tool");
  });

  test("a composed name over the 64-char limit is refused rather than truncated", () => {
    // A truncated name would still route — to whichever server shares the
    // prefix — so the collision would only surface as a call landing on the
    // wrong remote.
    const slug = "a".repeat(40);
    const tool = "b".repeat(40);
    let caught: unknown;
    try {
      buildMcpToolName(slug, tool);
    } catch (err) {
      caught = err;
    }
    expect((caught as McpToolNameError).reason).toBe("composed_too_long");
    expect(`mcp_${slug}__${tool}`.length).toBeGreaterThan(MCP_TOOL_NAME_MAX);
  });

  test("a name exactly at the limit is accepted", () => {
    // 4 (prefix) + slug + 2 (separator) + tool === 64
    const name = buildMcpToolName("a".repeat(20), "b".repeat(38));
    expect(name.length).toBe(MCP_TOOL_NAME_MAX);
  });
});

describe("parseMcpToolName", () => {
  test("round-trips every composed name back to its two halves", () => {
    const pairs: Array<[string, string]> = [
      ["rovo", "search"],
      ["rovo", "search_pages"],
      ["my-conn", "createIssue"],
      ["a", "b"],
      ["conn_1", "tool_2_x"],
    ];
    for (const [slug, tool] of pairs) {
      expect(parseMcpToolName(buildMcpToolName(slug, tool))).toEqual({
        slug,
        remote_tool: tool,
      });
    }
  });

  test("a slug ending in _ and a tool starting with _ do not collide", () => {
    // The pair that WOULD collide if the split point were "last underscore
    // run" instead of "first `__`": both compose distinct names, and each
    // parses back to itself.
    const a = buildMcpToolName("conn_a", "search");
    const b = buildMcpToolName("conn", "a_search");
    expect(a).not.toBe(b);
    expect(parseMcpToolName(a)).toEqual({ slug: "conn_a", remote_tool: "search" });
    expect(parseMcpToolName(b)).toEqual({ slug: "conn", remote_tool: "a_search" });
  });

  test("returns null for a name that is not ours", () => {
    expect(parseMcpToolName("list_workflows")).toBeNull();
    expect(parseMcpToolName("mcp_no_separator")).toBeNull();
    expect(parseMcpToolName("mcp___leading")).toBeNull();
  });

  test("refuses a name whose remote half still contains `__`", () => {
    // Only reachable from a slug that should never have been storable — the
    // DB CHECK is what makes this branch dead in practice. Refusing beats
    // picking one of two possible splits.
    expect(parseMcpToolName("mcp_conn__a__b")).toBeNull();
  });
});

describe("the slug shape the split point depends on", () => {
  test("the application schema and the composer agree on what a slug may be", () => {
    for (const bad of ["legacy__conn", "-lead", "trail-", "has.dot", "a".repeat(65), ""]) {
      expect(ConnectorSlugSchema.safeParse(bad).success).toBe(false);
      expect(() => buildMcpToolName(bad, "t")).toThrow(McpToolNameError);
    }
    for (const good of ["rovo", "my-conn", "conn_1", "a"]) {
      expect(ConnectorSlugSchema.safeParse(good).success).toBe(true);
      expect(CONNECTOR_SLUG_RE.test(good)).toBe(true);
    }
  });
});
