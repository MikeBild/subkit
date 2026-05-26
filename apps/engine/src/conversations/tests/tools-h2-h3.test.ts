// Tests for conversation tool registration — covers the H2/H3 tools
// (search_knowledge, list_skill_suggestions, propose_*) plus the
// `ask_user_*` family that paused-loop elicitations dispatch through.

import { describe, expect, test } from "bun:test";
import { getTool, listTools } from "../tools/index.ts";

describe("conversation tools — registration", () => {
  const EXPECTED_AUTHORING_TOOLS = [
    "analyze_scrape_target",
    "ask_user_choice",
    "ask_user_confirm",
    "ask_user_form",
    "ask_user_multi",
    "ask_user_text",
    "authenticate_oauth",
    "build_workflow",
    "call_connector",
    "cannot_help",
    "save_workflow_draft",
    "connect_steps",
    "discover_connector_endpoints",
    "discover_systems_from_files",
    "dry_run_step",
    "dry_run_transform",
    "dry_run_workflow",
    "fetch_connector_docs",
    "inspect_authoring_context",
    "inspect_connector_draft",
    "inspect_execution",
    "inspect_execution_step",
    "inspect_recipe",
    "inspect_workflow",
    "inspect_workflow_draft",
    "list_attachments",
    "list_skill_suggestions",
    "list_skills",
    "preview_attachment",
    "probe_connector",
    "probe_connector_draft",
    "propose_skill",
    "propose_step",
    "save_connector_draft",
    "search_docs",
    "search_knowledge",
    "start_connector_from_description",
    "start_connector_from_template",
    "start_workflow_from_goal",
    "start_workflow_from_recipe",
    "suggest_connector_templates",
    "suggest_jsonata_paths",
    "find_workflow",
    "find_connector",
    "find_skill",
    "find_role",
    "find_user",
    "inspect_role",
    "edit_role",
    "match_connector_template_by_url",
    "import_connector_from_spec",
    "test_connector",
    "update_connector_draft",
    "update_param",
    "edit_workflow_patch",
    "propose_schema_migration",
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
    "get_vendor_recipe",
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
    "get_engine_status",
    // Discovery (2 read + 1 write)
    "list_discovery_artifacts",
    "get_discovery_artifact",
    "approve_discovery_artifact",
    // Hand-written write tools
    "run_workflow",
    "delete_workflow",
    "delete_connector",
    "delete_knowledge_source",
    "delete_subscription",
    "revoke_api_key",
    "revoke_portal_token",
    "approve_skill_candidate",
    "approve_patch_candidate",
    "create_api_key",
    "create_knowledge_source",
    "create_schedule",
    "diagnose_latest_execution",
    "list_schedules",
    "update_schedule",
    "delete_schedule",
    "update_workflow",
    "update_connector",
    "update_knowledge_source",
    "update_subscription",
    "list_draft_snapshots",
    "restore_draft_snapshot",
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
