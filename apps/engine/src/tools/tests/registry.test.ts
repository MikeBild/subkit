// Registry contract tests.
//
// Active assertions exercise StaticToolProvider + ConversationToolProvider
// catalog shape. Execution (dispatcher, adapters) is covered by
// `dispatcher.test.ts` and the cross-surface parity tests — this file
// stays narrowly focused on catalog visibility + provider contracts.

import { describe, expect, test } from "bun:test";
import { listTools } from "../../conversations/tools/index.ts";
import { conversationToolProvider, staticToolProvider } from "../index.ts";
import { DRAFT_WRITE_MCP_UNAVAILABLE_REASON } from "../policy.ts";
import { buildRegistry, type ToolProvider } from "../registry.ts";

describe("tools/registry — providers (active)", () => {
  test("StaticToolProvider lists only the truly MCP-unique handlers", () => {
    const names = staticToolProvider.list({ surface: "mcp", mcpMode: "admin" }).map((d) => d.name);
    expect(names).toContain("authenticate");
    expect(names).toContain("list_recipes");
    expect(names).toContain("self_healing_scan");
    expect(names).toContain("subkit_settings");
    expect(names).toContain("subkit_update_setting");
    // The following names exist on the conversation registry — the
    // conversation version wins; the deleted mcp/tools/* duplicates
    // are replaced by the conversation-side tool routed through the
    // unified dispatcher.
    expect(names).not.toContain("test_connector");
    expect(names).not.toContain("match_connector_template_by_url");
    expect(names).not.toContain("inspect_recipe");
    expect(names).not.toContain("import_connector_from_spec");
  });

  test("StaticToolProvider hides self_healing_scan outside admin mode", () => {
    const productNames = staticToolProvider
      .list({ surface: "mcp", mcpMode: "product" })
      .map((d) => d.name);
    expect(productNames).not.toContain("self_healing_scan");
    expect(productNames).not.toContain("subkit_settings");
    expect(productNames).not.toContain("subkit_update_setting");
    expect(productNames).toContain("authenticate");
  });

  test("ConversationToolProvider mirrors listTools() on chat surface", () => {
    const expected = listTools().map((t) => t.name);
    const got = conversationToolProvider.list({ surface: "chat" }).map((d) => d.name);
    // Every chat-visible conversation tool surfaces in the provider.
    for (const name of expected) {
      expect(got).toContain(name);
    }
  });

  test("ConversationToolProvider omits draft_write from the MCP catalog but resolve() keeps the disabled descriptor", () => {
    const filter = { surface: "mcp", mcpMode: "authoring" } as const;
    const descriptors = conversationToolProvider.list(filter);
    // Catalog drops draft_write so badge-ignoring clients can't call+churn.
    expect(descriptors.find((d) => d.name === "save_workflow_draft")).toBeUndefined();
    expect(descriptors.find((d) => d.name === "dry_run_workflow")).toBeUndefined();

    // resolve() still returns the disabled descriptor — the dispatcher
    // short-circuits a forced/guessed call to not_available_on_surface
    // with the actionable "use conversation_start" reason.
    const saveDraft = conversationToolProvider.resolve("save_workflow_draft", filter);
    expect(saveDraft?.descriptor.disabled?.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);
    const dryRun = conversationToolProvider.resolve("dry_run_workflow", filter);
    expect(dryRun?.descriptor.disabled?.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);
  });

  test("ConversationToolProvider hides tenant_write tools on MCP read-only mode (except the exempt set)", () => {
    const writes = conversationToolProvider
      .list({ surface: "mcp", mcpMode: "admin", readOnly: true })
      .filter((d) => d.category === "tenant_write");
    // run_workflow is a workflow *run*, exempt from the readOnly hide (it
    // behaves like the always-on wf_ palette; RBAC still gates execution).
    // save_learning is an inert `proposed` candidate behind the human
    // approve gate — the capture loop's explicit channel stays callable.
    // Every other tenant_write stays hidden under readOnly.
    expect(writes.map((d) => d.name).sort()).toEqual([
      "approve_skill_candidate",
      "run_workflow",
      "save_learning",
    ]);
  });

  test("buildRegistry throws when two providers register the same name", () => {
    const dup: ToolProvider = {
      name: "DupProvider",
      list: () => [
        {
          name: "authenticate",
          description: "duplicate",
          category: "tenant_read",
          inputSchema: { type: "object" },
        },
      ],
      resolve: () => undefined,
    };
    expect(() => buildRegistry([staticToolProvider, dup])).toThrow(/registry collision/);
  });

  test("buildRegistry from real providers resolves a known tool name", () => {
    const registry = buildRegistry([staticToolProvider, conversationToolProvider]);
    const auth = registry.get("authenticate", { surface: "mcp", mcpMode: "product" });
    expect(auth).toBeDefined();
    expect(auth?.descriptor.name).toBe("authenticate");
    const probe = registry.get("probe_connector", { surface: "chat" });
    expect(probe).toBeDefined();
    expect(probe?.descriptor.name).toBe("probe_connector");
  });
});

describe("tools/registry — pending (todo)", () => {
  test.todo("get(name) returns the same descriptor regardless of which surface asked", () => {});
  test.todo("list({surface:'mcp', mcpMode:'authoring'}) is a strict superset of product (modulo disabled descriptors)", () => {});
  test.todo("list({surface:'mcp', mcpMode:'admin'}) is a strict superset of authoring", () => {});
});
