// find_tool — catalog meta-tool contract.
//
// Pins the properties the budget fix rests on: hits carry ONLY
// { name, category, summary } (never an inputSchema), the search runs over
// the caller's own mode via the registry filter, disabled descriptors and
// the meta-tool itself never surface, and name matches outrank description
// matches.

import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { ToolListFilter, ToolRegistry } from "../../tools/registry.ts";
import type { ToolDescriptor } from "../../tools/types.ts";
import { FIND_TOOL_TOOL_NAME, findToolMcpTool, handleFindTool } from "./find-tool.ts";

const PRINCIPAL = {
  id: "00000000-0000-0000-0000-000000000000",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  scopes: [],
} as unknown as ResolvedPrincipal;

function descriptor(partial: Partial<ToolDescriptor> & { name: string }): ToolDescriptor {
  return {
    description: "",
    category: "tenant_read",
    inputSchema: { type: "object", properties: {} },
    ...partial,
  } as ToolDescriptor;
}

const CATALOG: ToolDescriptor[] = [
  descriptor({
    name: "probe_connector",
    description:
      "Probe a saved connector: verify the credential resolves and the base URL responds. " +
      "Run this before authoring against the connector.",
  }),
  descriptor({
    name: "call_connector",
    description: "Call one endpoint on a saved connector and return the raw response.",
    category: "tenant_write",
  }),
  descriptor({
    name: "dry_run_transform",
    description: "Dry-run a transform step against sample input without touching a connector.",
  }),
  descriptor({
    name: "disabled_connector_tool",
    description: "A connector tool that is advertised but not callable.",
    disabled: { reason: "not callable here" },
  }),
  descriptor({
    name: FIND_TOOL_TOOL_NAME,
    description: findToolMcpTool.description ?? "",
  }),
];

function fakeRegistry(onList?: (filter: ToolListFilter) => void): ToolRegistry {
  return {
    list(filter) {
      onList?.(filter);
      return CATALOG;
    },
    get() {
      return undefined;
    },
  };
}

describe("handleFindTool", () => {
  test("matches name and description, ranks name hits first, and returns only {name, category, summary}", () => {
    const result = handleFindTool(
      { principal: PRINCIPAL, registry: fakeRegistry(), mcpMode: "authoring", readOnly: true },
      { query: "connector probe" },
    );
    if (!result.ok) throw new Error(result.data.error);
    const names = result.data.tools.map((t) => t.name);
    // probe_connector matches both terms in its NAME — it must lead.
    expect(names[0]).toBe("probe_connector");
    expect(names).toContain("call_connector");
    for (const hit of result.data.tools) {
      expect(Object.keys(hit).sort()).toEqual(["category", "name", "summary"]);
      expect(hit.summary.length).toBeLessThanOrEqual(140);
    }
    // The note tells the model every hit is directly callable.
    expect(result.data.note).toContain("tools/call");
  });

  test("summary is the first sentence of the description", () => {
    const result = handleFindTool(
      { principal: PRINCIPAL, registry: fakeRegistry(), mcpMode: "authoring", readOnly: true },
      { query: "probe" },
    );
    if (!result.ok) throw new Error(result.data.error);
    const probe = result.data.tools.find((t) => t.name === "probe_connector");
    expect(probe?.summary).toBe(
      "Probe a saved connector: verify the credential resolves and the base URL responds.",
    );
  });

  test("never returns itself or a disabled descriptor", () => {
    const result = handleFindTool(
      { principal: PRINCIPAL, registry: fakeRegistry(), mcpMode: "authoring", readOnly: true },
      { query: "tool connector" },
    );
    if (!result.ok) throw new Error(result.data.error);
    const names = result.data.tools.map((t) => t.name);
    expect(names).not.toContain(FIND_TOOL_TOOL_NAME);
    expect(names).not.toContain("disabled_connector_tool");
  });

  test("queries the registry with the dispatch's own mode and readOnly flag", () => {
    let seen: ToolListFilter | undefined;
    const result = handleFindTool(
      {
        principal: PRINCIPAL,
        registry: fakeRegistry((f) => {
          seen = f;
        }),
        mcpMode: "product",
        readOnly: true,
      },
      { query: "connector" },
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual({ surface: "mcp", mcpMode: "product", readOnly: true });
  });

  test("falls back to the principal's resolved mode when the dispatch carries none", () => {
    let seen: ToolListFilter | undefined;
    handleFindTool(
      {
        principal: PRINCIPAL,
        registry: fakeRegistry((f) => {
          seen = f;
        }),
      },
      { query: "connector" },
    );
    // No mcp:* scope on the principal → product mode, which publishes no
    // tenant writes → readOnly.
    expect(seen?.mcpMode).toBe("product");
    expect(seen?.readOnly).toBe(true);
  });

  test("applies the default limit and caps at the requested one", () => {
    const many: ToolDescriptor[] = Array.from({ length: 30 }, (_, i) =>
      descriptor({ name: `connector_tool_${i}`, description: "Reads connector data." }),
    );
    const registry: ToolRegistry = { list: () => many, get: () => undefined };
    const byDefault = handleFindTool(
      { principal: PRINCIPAL, registry, mcpMode: "authoring", readOnly: true },
      { query: "connector" },
    );
    if (!byDefault.ok) throw new Error(byDefault.data.error);
    expect(byDefault.data.tools.length).toBe(15);
    expect(byDefault.data.total_matches).toBe(30);
    const capped = handleFindTool(
      { principal: PRINCIPAL, registry, mcpMode: "authoring", readOnly: true },
      { query: "connector", limit: 3 },
    );
    if (!capped.ok) throw new Error(capped.data.error);
    expect(capped.data.tools.length).toBe(3);
  });

  test("rejects invalid args through the Zod boundary", () => {
    const registry = fakeRegistry();
    const empty = handleFindTool(
      { principal: PRINCIPAL, registry, mcpMode: "authoring", readOnly: true },
      { query: "" },
    );
    expect(empty.ok).toBe(false);
    const overLimit = handleFindTool(
      { principal: PRINCIPAL, registry, mcpMode: "authoring", readOnly: true },
      { query: "connector", limit: 41 },
    );
    expect(overLimit.ok).toBe(false);
  });

  test("published schema stays tiny and never leaks per-hit input schemas", () => {
    const schema = findToolMcpTool.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual([
      "limit",
      "query",
    ]);
    expect((schema.required as string[] | undefined) ?? []).toEqual(["query"]);
  });
});
