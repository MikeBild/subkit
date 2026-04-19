// Tests for conversation tool registration — covers the H2/H3 tools
// (search_knowledge, list_skill_suggestions, propose_*) plus the
// `ask_user_*` family that paused-loop elicitations dispatch through.

import { describe, expect, test } from "bun:test";
import { getTool, listTools } from "../tools/index.ts";

describe("conversation tools — registration", () => {
  const EXPECTED_AUTHORING_TOOLS = [
    "ask_user_choice",
    "ask_user_confirm",
    "ask_user_form",
    "ask_user_multi",
    "ask_user_text",
    "build_workflow",
    "commit_draft",
    "connect_steps",
    "dry_run_step",
    "dry_run_transform",
    "dry_run_workflow",
    "fetch_connector_docs",
    "inspect_authoring_context",
    "inspect_connector_draft",
    "inspect_workflow_draft",
    "list_attachments",
    "list_skill_suggestions",
    "list_skills",
    "preview_attachment",
    "probe_connector",
    "probe_connector_draft",
    "propose_connector",
    "propose_skill",
    "propose_step",
    "save_connector_draft",
    "search_knowledge",
    "start_connector_from_description",
    "start_connector_from_template",
    "start_workflow_from_goal",
    "suggest_connector_templates",
    "update_connector_draft",
    "update_param",
    "validate_connector_draft",
    "validate_draft",
  ] as const;

  // Generated read tools + hand-written writes from the gap-fix work.
  // Asserting the full set gives us a regression gate for additions
  // (a new tool without a registration line here fails the test).
  const EXPECTED_EXTENSION_TOOLS = [
    // Loaders + utility
    "load_skill",
    "get_raw_result",
    "web_search",
    "test_rbac_expression",
    // Generated read tools (15 domains)
    "list_workflows",
    "get_workflow",
    "list_connectors",
    "get_connector",
    "list_executions",
    "get_execution",
    "list_all_skills",
    "get_skill",
    "list_skill_candidates",
    "get_skill_candidate",
    "list_patch_candidates",
    "get_patch_candidate",
    "list_knowledge_sources",
    "get_knowledge_source",
    "search_knowledge_v2",
    "list_audit",
    "get_audit_entry",
    "get_llm_usage",
    "get_token_budget",
    "whoami",
    "list_users",
    "get_user",
    "list_api_keys",
    "get_api_key",
    "list_portal_tokens",
    "list_system_accounts",
    "list_roles",
    "get_role",
    "list_inbound_hooks",
    "get_inbound_hook",
    "list_subscriptions",
    "get_subscription",
    "list_tunnels",
    "get_tunnel",
    "get_engine_status",
    // Discovery (2 read + 1 write)
    "list_discovery_artifacts",
    "get_discovery_artifact",
    "approve_discovery_artifact",
    // Hand-written write tools
    "run_workflow",
    "approve_skill_candidate",
    "approve_patch_candidate",
  ] as const;

  test("the expected tool palette is registered", () => {
    const tools = listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = [...EXPECTED_AUTHORING_TOOLS, ...EXPECTED_EXTENSION_TOOLS].sort();
    expect(names).toEqual(expected);
  });

  test("search_knowledge tool is registered", () => {
    const tool = getTool("search_knowledge");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("search_knowledge");
    expect(tool!.description).toContain("Knowledge Sources");
  });

  test("list_skill_suggestions tool is registered", () => {
    const tool = getTool("list_skill_suggestions");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("list_skill_suggestions");
    expect(tool!.description).toContain("skill");
  });

  test("propose_connector tool is registered", () => {
    const tool = getTool("propose_connector");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("propose_connector");
    expect(tool!.description).toContain("Connector");
  });

  test("propose_skill tool is registered", () => {
    const tool = getTool("propose_skill");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("propose_skill");
    expect(tool!.description).toContain("Skill");
  });

  test("tool names are unique", () => {
    const tools = listTools();
    const names = tools.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test("all tools have inputSchema", () => {
    const tools = listTools();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
    }
  });

  test("all tools have execute function", () => {
    const tools = listTools();
    for (const tool of tools) {
      expect(typeof tool.execute).toBe("function");
    }
  });
});
