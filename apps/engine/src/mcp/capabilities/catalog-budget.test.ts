// Catalog-assembly contracts — `assembleCatalog` publishes the FULL
// authoring catalog for the resolved mode with no server-side budget,
// trim, or compression loop (see the file header on catalog-budget.ts:
// strict clients defer-load large catalogs natively, so the client's own
// tool-search handles size — verified empirically with an 80-tool probe
// on claude.ai + ChatGPT).
//
// Contracts pinned here:
//   1. The mode hierarchy is monotone: authoring publishes every tool
//      product publishes, plus the tools that BUILD definitions — the
//      conversation cluster and everything declaring `authoring_only`.
//      Product is the read-and-execute tier: reads plus the run tools.
//   2. `confirm_tool_call` can trigger only an already human-granted local
//      approval; its presence does not let a model approve its own work.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "bun:test";

import { MCP_AUTHORING_SCOPE } from "../../auth/scopes.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { MCP_CORE_TOOL_NAMES } from "../mode-resolver.ts";
import { assembleCatalog } from "./catalog-budget.ts";

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

function fakeWorkflowTool(i: number): Tool {
  return {
    name: `wf_workflow_${i}`,
    description: `Run the saved workflow "Workflow ${i}".`,
    inputSchema: { type: "object", properties: {} },
  } as Tool;
}

const PALETTE = Array.from({ length: 5 }, (_, i) => fakeWorkflowTool(i));

function namesFor(mode: "product" | "authoring"): Set<string> {
  return new Set(
    assembleCatalog({
      principal: principal(mode === "authoring" ? [MCP_AUTHORING_SCOPE] : []),
      readOnly: false,
      mode,
      fullPalette: PALETTE,
    }).map((t) => t.name),
  );
}

describe("mode hierarchy is monotone · authoring ⊇ product", () => {
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

  test("product carries reads and runs; authoring adds the tools that build definitions", () => {
    const product = namesFor("product");
    const authoring = namesFor("authoring");

    // Reading the tenant and calling an existing connector is what the
    // read-and-execute tier is FOR. These used to be authoring-only, which
    // left a plain credential with an 8-tool floor and no way to see anything.
    for (const readOrRun of ["call_connector", "list_skills", "list_workflows"]) {
      expect(product.has(readOrRun)).toBe(true);
      expect(authoring.has(readOrRun)).toBe(true);
    }

    // What authoring adds is the composing: discovering an API's shape,
    // dry-running a transform, opening an authoring conversation. Each of
    // these declares `authoring_only` at its definition site.
    for (const buildsDefinitions of [
      "discover_connector_endpoints",
      "dry_run_transform",
      "conversation_start",
    ]) {
      expect(product.has(buildsDefinitions)).toBe(false);
      expect(authoring.has(buildsDefinitions)).toBe(true);
    }
  });

  test("every search-first core tool is present in every mode", () => {
    for (const mode of ["product", "authoring"] as const) {
      const names = namesFor(mode);
      for (const core of MCP_CORE_TOOL_NAMES) expect(names.has(core)).toBe(true);
    }
  });
});

describe("the approval replay handle is discoverable", () => {
  test("product and authoring publish the existing-approval trigger", () => {
    for (const mode of ["product", "authoring"] as const) {
      expect(namesFor(mode).has("confirm_tool_call")).toBe(true);
    }
  });

  test("the search-first floor retains the approval replay tool", () => {
    expect(MCP_CORE_TOOL_NAMES.has("confirm_tool_call")).toBe(true);
  });
});
