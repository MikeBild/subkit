// Budget-fit cascade + schema compression — pure unit coverage.
//
// Pins the two contracts the fix rests on:
//   1. compressToolSchema trims prose only — never the callable structure.
//   2. fitCatalogToBudget fits the PRODUCT (strict) surface under the token
//      budget without dropping the search-first core, and leaves the capable
//      authoring/admin surfaces rich (no destructive trim).

import { describe, expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_AUTHORING_SCOPE } from "../../auth/scopes.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { MCP_CORE_TOOL_NAMES } from "../mode-resolver.ts";
import {
  assembleTier,
  compressToolSchema,
  estimateCatalogTokens,
  fitCatalogToBudget,
} from "./catalog-budget.ts";

function principal(scopes: string[]): ResolvedPrincipal {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    type: "api_key",
    tenant_id: "00000000-0000-0000-0000-000000000001",
    scopes,
    permissions: [],
    role_ids: [],
    actor_kind: "api_key",
    description: null,
    metadata: null,
    expires_at: null,
  } as unknown as ResolvedPrincipal;
}

// A chunky synthetic wf_ tool so a 40-tool palette blows the budget and the
// cascade has to trim it.
function fakeWorkflowTool(i: number): Tool {
  return {
    name: `wf_workflow_${i}`,
    description:
      `Run the saved workflow "Workflow ${i}". Executes its stored steps and connectors and ` +
      "returns the result. Prefer this over re-deriving the same query with call_connector. " +
      "This description is intentionally long to consume schema tokens for the budget test.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO timestamp lower bound for the query window." },
        limit: { type: "number", description: "Maximum number of rows to return from the run." },
      },
    },
  } as Tool;
}

const PALETTE = Array.from({ length: 40 }, (_, i) => fakeWorkflowTool(i));

describe("compressToolSchema", () => {
  test("preserves structure, trims prose, drops examples", () => {
    const tool: Tool = {
      name: "demo",
      description: "x".repeat(500),
      inputSchema: {
        type: "object",
        required: ["a"],
        properties: {
          a: { type: "string", description: "y".repeat(300), examples: ["e1", "e2"] },
          b: { type: "number" },
        },
        additionalProperties: false,
      },
    } as Tool;
    const out = compressToolSchema(tool);
    // Prose trimmed.
    expect(out.description!.length).toBeLessThan(tool.description!.length);
    const schema = out.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const a = props.a as Record<string, unknown>;
    const b = props.b as Record<string, unknown>;
    // Structure preserved verbatim.
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["a"]);
    expect(schema.additionalProperties).toBe(false);
    expect(a.type).toBe("string");
    expect(b.type).toBe("number");
    // examples (pure prose) dropped; description trimmed.
    expect(a.examples).toBeUndefined();
    expect((a.description as string).length).toBeLessThan(300);
  });

  test("is a no-op on already-small prose", () => {
    const tool: Tool = {
      name: "small",
      description: "short",
      inputSchema: { type: "object", properties: {} },
    } as Tool;
    expect(compressToolSchema(tool)).toEqual(tool);
  });
});

describe("fitCatalogToBudget", () => {
  const base = {
    principal: principal([]), // no scopes → product mode
    readOnly: false,
    fullPalette: PALETTE,
  };

  test("product: fits the budget, trims the palette, keeps the search-first core", () => {
    const fit = fitCatalogToBudget({ ...base, initialMode: "product" });
    // Budget met (or floor reached — assert it at least did not grow and is
    // under budget given the synthetic palette is the only bulk).
    expect(fit.estTokensAfter).toBeLessThanOrEqual(fit.estTokensBefore);
    expect(fit.estTokensAfter).toBeLessThan(5000);
    // Palette trimmed to the Top-N floor.
    expect(fit.paletteLimit).toBe(10);
    // Search-first core present regardless of trimming.
    const names = new Set(fit.tools.map((t) => t.name));
    for (const core of MCP_CORE_TOOL_NAMES) expect(names.has(core)).toBe(true);
  });

  test("product: deterministic — same input yields the same catalog", () => {
    const a = fitCatalogToBudget({ ...base, initialMode: "product" });
    const b = fitCatalogToBudget({ ...base, initialMode: "product" });
    expect(a.tools.map((t) => t.name)).toEqual(b.tools.map((t) => t.name));
  });

  test("authoring: trimmed + compressed but no named tool dropped", () => {
    const authoring = { ...base, principal: principal([MCP_AUTHORING_SCOPE]) };
    const before = fitCatalogToBudget({
      ...authoring,
      initialMode: "authoring",
    });
    // Non-destructive levers fire (palette → Top-N, compression, then deeper
    // palette trim) because the rich authoring surface is over budget; the
    // catalog shrinks but every NAMED (non-wf_) tool survives. The palette is
    // the only part of the manifest that yields — it has a complete fallback
    // (find_workflow → run_workflow(slug)); the allow-list does not.
    expect(before.mode).toBe("authoring");
    expect(before.paletteLimit).toBeLessThanOrEqual(10);
    expect(before.paletteLimit).toBeGreaterThan(0);
    expect(before.compressed).toBe(true);
    expect(before.estTokensAfter).toBeLessThan(before.estTokensBefore);
    const namedFull = assembleTier({
      ...authoring,
      mode: "authoring",
      paletteLimit: 40,
      compress: false,
    })
      .filter((t) => !t.name.startsWith("wf_"))
      .map((t) => t.name)
      .sort();
    const namedFit = before.tools
      .filter((t) => !t.name.startsWith("wf_"))
      .map((t) => t.name)
      .sort();
    expect(namedFit).toEqual(namedFull); // every named tool preserved
  });

  test("essentials lead the catalog: core, then wf_ palette, then conversation_start", () => {
    const authoring = { ...base, principal: principal([MCP_AUTHORING_SCOPE]) };
    const fit = fitCatalogToBudget({ ...authoring, initialMode: "authoring" });
    const names = fit.tools.map((t) => t.name);
    const firstWf = names.findIndex((n) => n.startsWith("wf_"));
    const firstNonEssential = names.findIndex(
      (n) => !MCP_CORE_TOOL_NAMES.has(n) && !n.startsWith("wf_") && n !== "conversation_start",
    );
    const convStart = names.indexOf("conversation_start");
    // Core names appear before the first wf_ tool…
    for (const core of MCP_CORE_TOOL_NAMES) {
      if (names.includes(core)) expect(names.indexOf(core)).toBeLessThan(firstWf);
    }
    // …and conversation_start (when present) leads the verbose tail.
    if (convStart >= 0 && firstNonEssential >= 0) {
      expect(convStart).toBeLessThan(firstNonEssential);
    }
  });

  test("estimateCatalogTokens grows with catalog size", () => {
    expect(estimateCatalogTokens(PALETTE)).toBeGreaterThan(
      estimateCatalogTokens(PALETTE.slice(0, 5)),
    );
  });
});
