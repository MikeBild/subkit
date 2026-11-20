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
    expect(names).toContain("list_apps");
    expect(names).toContain("get_app");
    expect(names).toContain("subkit_update_setting");
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
    expect(productNames).not.toContain("list_apps");
    expect(productNames).not.toContain("get_app");
    expect(productNames).not.toContain("subkit_update_setting");
    expect(productNames).toContain("authenticate");
  });

  test("ConversationToolProvider mirrors listTools() on chat surface", () => {
    const expected = listTools().map((t) => t.name);
    const got = conversationToolProvider.list({ surface: "chat" }).map((d) => d.name);
    for (const name of expected) {
      expect(got).toContain(name);
    }
  });

  test("ConversationToolProvider omits draft_write from the MCP catalog but resolve() keeps the disabled descriptor", () => {
    const filter = { surface: "mcp", mcpMode: "authoring" } as const;
    const descriptors = conversationToolProvider.list(filter);
    expect(descriptors.find((d) => d.name === "save_workflow_draft")).toBeUndefined();
    expect(descriptors.find((d) => d.name === "dry_run_workflow")).toBeUndefined();

    const saveDraft = conversationToolProvider.resolve("save_workflow_draft", filter);
    expect(saveDraft?.descriptor.disabled?.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);
    const dryRun = conversationToolProvider.resolve("dry_run_workflow", filter);
    expect(dryRun?.descriptor.disabled?.reason).toBe(DRAFT_WRITE_MCP_UNAVAILABLE_REASON);
  });

  test("ConversationToolProvider hides tenant_write tools on MCP read-only mode (except the exempt set)", () => {
    const writes = conversationToolProvider
      .list({ surface: "mcp", mcpMode: "admin", readOnly: true })
      .filter((d) => d.category === "tenant_write");
    expect(writes.map((d) => d.name).sort()).toEqual([
      "abort_task_run",
      "approve_skill_candidate",
      "propose_workflow_repair",
      "reject_skill_candidate",
      "run_task",
      "run_workflow",
      "save_learning",
      "save_task",
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

describe("tools/registry — surface contracts", () => {
  const registry = buildRegistry([staticToolProvider, conversationToolProvider]);

  test("tools visible on chat and MCP retain their descriptor and resource policy", () => {
    const chat = { surface: "chat" } as const;
    const mcp = { surface: "mcp", mcpMode: "admin" } as const;
    const mcpNames = new Set(registry.list(mcp).map((tool) => tool.name));
    const common = registry.list(chat).filter((tool) => mcpNames.has(tool.name));
    expect(common.map((tool) => tool.name)).toContain("probe_connector");
    for (const tool of common) {
      const chatEntry = registry.get(tool.name, chat);
      const mcpEntry = registry.get(tool.name, mcp);
      expect(chatEntry).toBeDefined();
      expect(mcpEntry).toBeDefined();
      expect(JSON.stringify(chatEntry?.descriptor)).toBe(JSON.stringify(mcpEntry?.descriptor));
      const chatResource = chatEntry?.descriptor.rbac?.resource;
      const mcpResource = mcpEntry?.descriptor.rbac?.resource;
      expect(typeof chatResource).toBe(typeof mcpResource);
      for (const args of [
        {},
        {
          id: "resource-id",
          workflow_id: "workflow-id",
          execution_id: "execution-id",
          connector_id: "connector-id",
          role_id: "role-id",
          knowledge_source_id: "knowledge-source-id",
          candidate_id: "candidate-id",
          candidate_ids: ["candidate-id"],
        },
      ]) {
        expect(chatResource?.(args)).toEqual(mcpResource?.(args));
      }
    }
  });

  test("MCP authoring preserves product tools and adds write tools without draft-only tools", () => {
    const product = registry.list({ surface: "mcp", mcpMode: "product" });
    const authoring = registry.list({ surface: "mcp", mcpMode: "authoring" });
    const names = new Set(authoring.map((tool) => tool.name));
    for (const tool of product) expect(names.has(tool.name)).toBe(true);
    expect(authoring.length).toBeGreaterThan(product.length);
    expect(names.has("create_knowledge_source")).toBe(true);
    expect(product.some((tool) => tool.name === "create_knowledge_source")).toBe(false);
    expect(authoring.some((tool) => tool.category === "draft_write")).toBe(false);
  });

  test("MCP admin preserves authoring tools and adds the administrative operations", () => {
    const authoring = registry.list({ surface: "mcp", mcpMode: "authoring" });
    const admin = registry.list({ surface: "mcp", mcpMode: "admin" });
    const names = new Set(admin.map((tool) => tool.name));
    for (const tool of authoring) expect(names.has(tool.name)).toBe(true);
    expect(admin.length).toBeGreaterThan(authoring.length);
    expect(names.has("self_healing_scan")).toBe(true);
    expect(authoring.some((tool) => tool.name === "self_healing_scan")).toBe(false);
  });
});
