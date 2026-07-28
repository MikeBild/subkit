// Pins what the MCP catalogue actually publishes per mode.
//
// Why this exists: `catalog-budget.ts` used to claim in prose that authoring
// published "no tenant_write except run_workflow". The code never did that —
// `conversation.ts` gates on `filter.mcpMode === "product"` and nothing else,
// so authoring and admin resolve to an identical list including
// `restore_workflow_version` and `update_workflow`. Customer documentation was
// written from that comment and had to be corrected. A comment is a claim; only
// a test is proof, so the real shape is asserted here.
//
// The invariant the docs and the governance story genuinely depend on is the
// last block: no external MCP client can edit a workflow draft step by step,
// in any mode. If that ever changes, this test must fail loudly.

import { describe, expect, it } from "bun:test";
import { conversationToolProvider } from "../../tools/providers/conversation.ts";

const names = (mcpMode: "product" | "authoring" | "admin") =>
  new Set(conversationToolProvider.list({ surface: "mcp", mcpMode }).map((d) => d.name));

describe("MCP catalogue — product is the only mode that trims", () => {
  it("authoring and admin publish an identical tool set", () => {
    // Not an aspiration — a statement of current fact. Narrowing one of them
    // later is a deliberate change that should update this test on purpose.
    expect([...names("authoring")].sort()).toEqual([...names("admin")].sort());
  });

  it("product is a strict subset of authoring", () => {
    const product = names("product");
    const authoring = names("authoring");
    expect(product.size).toBeGreaterThan(0);
    expect(product.size).toBeLessThan(authoring.size);
    for (const n of product) expect(authoring.has(n)).toBe(true);
  });
});

describe("MCP catalogue — mode name does not imply reachability", () => {
  // The bound on a caller is per-tool RBAC in the dispatcher, not the mode.
  // These tools ARE listed in authoring; being listed is not being allowed.
  for (const tool of ["restore_workflow_version", "update_workflow"]) {
    it(`${tool} is published in authoring mode (RBAC gates the call, not the catalogue)`, () => {
      expect(names("authoring").has(tool)).toBe(true);
    });
  }

  it("run_workflow is reachable in every mode", () => {
    for (const m of ["product", "authoring", "admin"] as const) {
      expect(names(m).has("run_workflow")).toBe(true);
    }
  });
});

describe("MCP catalogue — no draft_write tool is reachable in ANY mode", () => {
  // THE invariant. External clients cannot compose a workflow definition
  // step by step; every step edit routes through the engine's own authoring
  // loop inside a conversation.
  const DRAFT_EDITORS = [
    "edit_workflow_patch",
    "save_workflow_draft",
    "dry_run_workflow",
    "validate_draft",
    "inspect_workflow_draft",
  ];

  for (const m of ["product", "authoring", "admin"] as const) {
    it(`${m} mode omits every draft editor`, () => {
      const listed = names(m);
      for (const t of DRAFT_EDITORS) expect(listed.has(t)).toBe(false);
    });

    it(`${m} mode publishes no draft_write category at all`, () => {
      // Broader than the name list above: catches a NEW draft_write tool that
      // would otherwise slip onto the surface unnoticed.
      const categories = conversationToolProvider
        .list({ surface: "mcp", mcpMode: m })
        .map((d) => d.category);
      expect(categories).not.toContain("draft_write");
    });
  }

  it("the chat surface DOES carry them — the omission is MCP-specific", () => {
    // Guards against someone "fixing" this by hiding draft_write everywhere,
    // which would break authoring in the REPL and chat.
    const chat = new Set(conversationToolProvider.list({ surface: "chat" }).map((d) => d.name));
    expect(chat.has("edit_workflow_patch")).toBe(true);
  });
});
