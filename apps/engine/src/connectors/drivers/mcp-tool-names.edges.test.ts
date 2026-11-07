import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { buildMcpToolName, McpToolNameError, mcpEgressInput, parseMcpToolName } from "./mcp.ts";

function refusal(slug: string, tool: string): McpToolNameError {
  try {
    buildMcpToolName(slug, tool);
  } catch (err) {
    if (err instanceof McpToolNameError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("buildMcpToolName refusals explain themselves", () => {
  test("the refusal is a named McpToolNameError", () => {
    expect(refusal("a__b", "t").name).toBe("McpToolNameError");
  });

  test("an invalid slug refusal quotes the slug and the double-underscore rule", () => {
    const err = refusal("bad.slug", "t");
    expect(err.message).toContain("connector slug 'bad.slug' cannot namespace an MCP tool");
    expect(err.message).toContain("contain no '__'");
  });

  test("an invalid remote tool refusal quotes the tool and the charset", () => {
    const err = refusal("rovo", "jira.search");
    expect(err.message).toContain("remote tool name 'jira.search' is not addressable");
    expect(err.message).toContain("^[a-zA-Z0-9_-]{1,64}$");
  });

  test("an over-long name refusal states the composed length and the limit", () => {
    const err = refusal("a".repeat(40), "b".repeat(20));
    expect(err.message).toContain("is 66 chars — over the 64-char tool-name limit");
  });
});

describe("parseMcpToolName edges", () => {
  test("a name without the mcp_ prefix is never split, even when it contains the separator", () => {
    expect(parseMcpToolName("xyz_conn__tool")).toBeNull();
    expect(parseMcpToolName("abcdconn__tool")).toBeNull();
  });

  test("a name whose remote half is empty is not ours", () => {
    expect(parseMcpToolName("mcp_conn__")).toBeNull();
  });

  test("the minimal composed name splits into one-character halves", () => {
    expect(parseMcpToolName("mcp_a__b")).toEqual({ slug: "a", remote_tool: "b" });
  });

  test("parsing never throws and only accepts names that compose back to themselves", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        const parsed = parseMcpToolName(name);
        if (parsed === null) return true;
        return `mcp_${parsed.slug}__${parsed.remote_tool}` === name;
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  test("every composable pair round-trips", () => {
    const slug = fc.stringMatching(/^[a-z0-9]{1,20}$/);
    const tool = fc.stringMatching(/^[a-zA-Z0-9-]{1,30}$/);
    fc.assert(
      fc.property(slug, tool, (s, t) => {
        expect(parseMcpToolName(buildMcpToolName(s, t))).toEqual({ slug: s, remote_tool: t });
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });
});

describe("mcpEgressInput", () => {
  const base = {
    executor: {} as never,
    tenant_id: "t1",
    actor_id: null,
    actor_type: "system" as const,
    connector: { id: "c1", slug: "docs", url: "https://docs.example.com/mcp" },
    call: { operation: "call_tool" as const, tool: "search", arguments: {} },
    source: "execution" as const,
  };

  test("an egress without execution context carries no execution keys at all", () => {
    const input = mcpEgressInput(base);
    expect(Object.keys(input).sort()).toEqual(
      [
        "executor",
        "tenant_id",
        "actor_id",
        "actor_type",
        "connector_id",
        "connector_slug",
        "driver",
        "credential_id",
        "operation",
        "url",
        "source",
      ].sort(),
    );
    expect(input).toMatchObject({ driver: "mcp", operation: "tools/call", credential_id: null });
  });

  test("an egress inside a run names the execution, workflow and step", () => {
    const input = mcpEgressInput({
      ...base,
      execution_id: "e1",
      workflow_id: "w1",
      step_id: "s1",
    });
    expect(input).toMatchObject({ execution_id: "e1", workflow_id: "w1", step_id: "s1" });
  });
});
