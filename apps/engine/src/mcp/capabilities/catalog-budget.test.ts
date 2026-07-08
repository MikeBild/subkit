// Catalog-budget regression pins — companion to `budget-fit.test.ts`.
//
// Three contracts that must hold going forward:
//   1. `authoring` mode fits under `SCHEMA_TOKEN_BUDGET` once the non-destructive
//      levers (palette trim + prose compression) fire on a realistic (over-budget)
//      palette — an `over_budget` authoring catalog silently degrades every
//      strict client the same way a `product` one would.
//   2. The authoring SESSION cluster (`conversation_append`, `conversation_get`,
//      `conversation_commit`, `conversation_respond_elicitation`) shares
//      `conversation_start`'s essentials rank and lands as one contiguous block
//      immediately after the `wf_` palette — so a client that truncates the
//      manifest tail cannot end up with the entry point but not the
//      continuation.
//   3. `confirm_tool_call`'s published `inputSchema` carries no `arguments`
//      property — the approval is a capability handle (`tool` + `confirm_id`),
//      never a re-transmission challenge.
//   4. The mode hierarchy is monotone: authoring publishes every tool product
//      publishes. It once did not — authoring shipped `list_recipes` with no
//      `inspect_recipe` to read a recipe, while a product client on the same
//      engine held both.

import { describe, expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_AUTHORING_SCOPE } from "../../auth/scopes.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { MCP_CORE_TOOL_NAMES } from "../mode-resolver.ts";
import {
  assembleTier,
  CONFIRM_TOOL_CALL_TOOL,
  DEFAULT_PALETTE_LIMIT,
  fitCatalogToBudget,
  SCHEMA_TOKEN_BUDGET,
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

// Same synthetic-palette shape as `budget-fit.test.ts`: a chunky per-workflow
// tool so a 40-tool palette blows the budget and the cascade has to trim it.
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

// The authoring session cluster — one entry point, four continuation tools.
// `conversation_start` is one of `AUTHORING_SESSION_TOOL_NAMES` in
// `catalog-budget.ts`; the set is not exported (it is an internal ranking
// detail), so this test asserts the observable contract — contiguous
// placement in the assembled catalog — rather than reaching into the module.
const AUTHORING_SESSION_NAMES = [
  "conversation_start",
  "conversation_append",
  "conversation_respond_elicitation",
  "conversation_get",
  "conversation_commit",
];

describe("fitCatalogToBudget · authoring mode fits under budget", () => {
  test("authoring lands at or under SCHEMA_TOKEN_BUDGET with a realistic over-budget palette", () => {
    const fit = fitCatalogToBudget({
      principal: principal([MCP_AUTHORING_SCOPE]),
      readOnly: false,
      fullPalette: PALETTE,
      initialMode: "authoring",
    });
    // Started over budget (the synthetic palette forces the cascade to fire) …
    expect(fit.estTokensBefore).toBeGreaterThan(SCHEMA_TOKEN_BUDGET);
    // … and the non-destructive levers (palette trim, then compression) bring
    // it under budget without dropping a named tool.
    expect(fit.estTokensAfter).toBeLessThanOrEqual(SCHEMA_TOKEN_BUDGET);
    expect(fit.compressed).toBe(true);
  });

  test("authoring under budget still carries every authoring session tool", () => {
    const fit = fitCatalogToBudget({
      principal: principal([MCP_AUTHORING_SCOPE]),
      readOnly: false,
      fullPalette: PALETTE,
      initialMode: "authoring",
    });
    const names = new Set(fit.tools.map((t) => t.name));
    for (const sessionTool of AUTHORING_SESSION_NAMES) expect(names.has(sessionTool)).toBe(true);
    for (const core of MCP_CORE_TOOL_NAMES) expect(names.has(core)).toBe(true);
  });
});

describe("fitCatalogToBudget · authoring session cluster survives a tail truncation", () => {
  function authoringNames(): string[] {
    const fit = fitCatalogToBudget({
      principal: principal([MCP_AUTHORING_SCOPE]),
      readOnly: false,
      fullPalette: PALETTE,
      initialMode: "authoring",
    });
    return fit.tools.map((t) => t.name);
  }

  test("the five session tools form one contiguous block", () => {
    const names = authoringNames();
    const indices = AUTHORING_SESSION_NAMES.map((n) => names.indexOf(n)).sort((a, b) => a - b);
    for (const i of indices) expect(i).toBeGreaterThanOrEqual(0);
    const first = indices[0]!;
    const last = indices[indices.length - 1]!;
    // No gap: every slot between the first and last session tool IS a
    // session tool — nothing else interleaves the block.
    expect(last - first + 1).toBe(AUTHORING_SESSION_NAMES.length);
    for (let i = first; i <= last; i++) {
      expect(AUTHORING_SESSION_NAMES).toContain(names[i] ?? "");
    }
  });

  test("the block sits immediately after the wf_ palette, before every other named tool", () => {
    const names = authoringNames();
    const lastWf = names.reduce((acc, n, i) => (n.startsWith("wf_") ? i : acc), -1);
    const blockIndices = AUTHORING_SESSION_NAMES.map((n) => names.indexOf(n));
    for (const i of blockIndices) expect(i).toBeGreaterThan(lastWf);
    // Nothing outside the cluster (and outside the wf_ palette / core) appears
    // before the LAST session tool — i.e. the cluster is not scattered behind
    // unrelated rank-3 tools.
    const lastSessionIdx = Math.max(...blockIndices);
    for (let i = lastWf + 1; i <= lastSessionIdx; i++) {
      expect(AUTHORING_SESSION_NAMES).toContain(names[i] ?? "");
    }
  });

  test("a client that truncates the tail right after the block keeps the whole cluster", () => {
    const names = authoringNames();
    const blockIndices = AUTHORING_SESSION_NAMES.map((n) => names.indexOf(n));
    const cutAt = Math.max(...blockIndices) + 1;
    const truncated = new Set(names.slice(0, cutAt));
    for (const sessionTool of AUTHORING_SESSION_NAMES)
      expect(truncated.has(sessionTool)).toBe(true);
  });

  test("a client that truncates BEFORE the block loses the whole cluster together (never a partial entry point)", () => {
    const names = authoringNames();
    const blockIndices = AUTHORING_SESSION_NAMES.map((n) => names.indexOf(n));
    const firstBlockIdx = Math.min(...blockIndices);
    const truncated = new Set(names.slice(0, firstBlockIdx));
    for (const sessionTool of AUTHORING_SESSION_NAMES)
      expect(truncated.has(sessionTool)).toBe(false);
  });
});

describe("mode hierarchy is monotone · authoring ⊇ product", () => {
  function namesFor(mode: "product" | "authoring"): Set<string> {
    return new Set(
      assembleTier({
        principal: principal(mode === "authoring" ? [MCP_AUTHORING_SCOPE] : []),
        readOnly: false,
        mode,
        paletteLimit: DEFAULT_PALETTE_LIMIT,
        compress: false,
        fullPalette: [],
      }).map((t) => t.name),
    );
  }

  test("every tool the product catalog publishes is in the authoring catalog", () => {
    const product = namesFor("product");
    const authoring = namesFor("authoring");
    const missing = [...product].filter((n) => !authoring.has(n));
    expect(missing).toEqual([]);
  });

  test("authoring is a STRICT superset — it adds tools product does not have", () => {
    const product = namesFor("product");
    const authoring = namesFor("authoring");
    expect(authoring.size).toBeGreaterThan(product.size);
  });

  test("a run tool never ships without the tool that resolves its polling handle", () => {
    // A `wf_<slug>` / `run_workflow` call that outruns the MCP inline window
    // hands back an `execution_id`. Publishing the run tool while withholding
    // `get_execution` advertises a result the caller can never fetch.
    for (const mode of ["product", "authoring"] as const) {
      const names = namesFor(mode);
      expect(names.has("run_workflow")).toBe(true);
      expect(names.has("get_execution")).toBe(true);
    }
  });
});

describe("confirm_tool_call · capability handle, not a re-transmission challenge", () => {
  test("published inputSchema has no `arguments` property", () => {
    const schema = CONFIRM_TOOL_CALL_TOOL.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(props).not.toHaveProperty("arguments");
  });

  test("published inputSchema requires only `tool` and `confirm_id`", () => {
    const schema = CONFIRM_TOOL_CALL_TOOL.inputSchema as Record<string, unknown>;
    expect(schema.required).toEqual(["tool", "confirm_id"]);
  });
});
