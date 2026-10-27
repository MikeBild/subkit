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
    "author_workflow",
    "call_connector",
    "cannot_help",
    "save_workflow_draft",
    "discover_connector_endpoints",
    "discover_systems_from_files",
    "dry_run_step",
    "dry_run_transform",
    "dry_run_workflow",
    "enroll_service_package_connector",
    "export_diagnostic_context",
    "fetch_connector_docs",
    "fetch_connector_self_description",
    "inspect_authoring_context",
    "inspect_playbook",
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
    "save_connector_draft",
    "search_docs",
    "save_learning",
    "start_connector_from_description",
    "start_connector_from_template",
    "start_workflow_from_recipe",
    "suggest_connector_templates",
    "suggest_jsonata_paths",
    "find_workflow",
    "find_connector",
    "request_connector_reauth",
    "review_workflow_automation",
    "find_skill",
    "find_role",
    "find_user",
    "inspect_role",
    "edit_role",
    "match_connector_template_by_url",
    "import_connector_from_spec",
    "prepare_service_package_workflow",
    "test_connector",
    "update_connector_draft",
    "edit_workflow_patch",
    "open_workflow_draft",
    "propose_schema_migration",
    "validate_connector_draft",
    "validate_draft",
  ] as const;

  const EXPECTED_EXTENSION_TOOLS = [
    "load_skill",
    "get_raw_result",
    "test_rbac_expression",
    "get_vendor_recipe",
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
    "preview_patch_candidate",
    "dry_run_patch_candidate",
    "list_knowledge_sources",
    "get_knowledge_source",
    "search_knowledge",
    "read_knowledge",
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
    "list_discovery_artifacts",
    "get_discovery_artifact",
    "approve_discovery_artifact",
    "resolve_capability_gap",
    "list_intake_categories",
    "list_intake_items",
    "get_intake_item",
    "discard_intake_items",
    "restore_intake_item",
    "move_intake_item",
    "set_default_intake_category",
    "create_intake_proposal",
    "revise_intake_proposal",
    "list_capability_gaps",
    "switch_authoring_focus",
    "run_workflow",
    "rerun_execution",
    "delete_workflow",
    "delete_connector",
    "delete_knowledge_source",
    "delete_subscription",
    "revoke_api_key",
    "revoke_portal_token",
    "approve_skill_candidate",
    "reject_skill_candidate",
    "approve_patch_candidate",
    "create_api_key",
    "create_knowledge_source",
    "analyze_knowledge_source",
    "promote_connector",
    "update_skill",
    "delete_skill",
    "create_schedule",
    "diagnose_latest_execution",
    "list_schedules",
    "update_schedule",
    "delete_schedule",
    "update_workflow",
    "update_connector",
    "update_knowledge_source",
    "update_playbook",
    "update_subscription",
    "list_draft_snapshots",
    "restore_draft_snapshot",
    "restore_workflow_version",
    "diagnose_workflow",
    "propose_workflow_repair",
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

  test("learnings are collected into intake, never filed as skill proposals by the chat", () => {
    expect(getTool("propose_skill")).toBeUndefined();
    expect(getTool("create_skill")).toBeUndefined();
    expect(getTool("save_learning")?.description).toContain("Intake");
  });

  test("intake proposal confirmation is never a conversation tool", () => {
    expect(getTool("confirm_intake_proposal")).toBeUndefined();
    expect(listTools().some((tool) => tool.name === "confirm_intake_proposal")).toBe(false);
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
