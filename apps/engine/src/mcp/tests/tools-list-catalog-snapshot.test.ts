// Full MCP catalog identity pin, per mode. Locks the exact set of static
// tool names `tools/list` returns for product / authoring / admin so a tool
// silently added, removed, or renamed — or a mode-gating regression — fails
// the suite. `wf_*` tools are excluded: they are generated per-tenant from
// saved workflows, not part of the static catalog.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("tools-list-catalog-snapshot");
});

afterAll(async () => {
  await suite.cleanup();
});

const WF_TOOL_PATTERN = /^wf_/;

async function staticToolNames(apiKey: string): Promise<string[]> {
  const client = await suite.connectWithApiKey(apiKey);
  const result = await client.listTools();
  return result.tools
    .map((t) => t.name)
    .filter((name) => !WF_TOOL_PATTERN.test(name))
    .sort();
}

const PRODUCT_TOOLS = [
  "authenticate",
  "find_workflow",
  "get_execution",
  "inspect_recipe",
  "list_recipes",
  "match_connector_template_by_url",
  "run_workflow",
  "test_connector",
];

const AUTHORING_TOOLS = [
  "analyze_scrape_target",
  "authenticate",
  "call_connector",
  "cannot_help",
  "conversation_append",
  "conversation_commit",
  "conversation_get",
  "conversation_respond_elicitation",
  "conversation_start",
  "discover_connector_endpoints",
  "discover_systems_from_files",
  "dry_run_patch_candidate",
  "dry_run_transform",
  "fetch_connector_docs",
  "fetch_connector_self_description",
  "find_connector",
  "find_role",
  "find_skill",
  "find_user",
  "find_workflow",
  "get_api_key",
  "get_audit_entry",
  "get_connector",
  "get_discovery_artifact",
  "get_engine_status",
  "get_execution",
  "get_inbound_hook",
  "get_knowledge_source",
  "get_llm_usage",
  "get_patch_candidate",
  "get_raw_result",
  "get_role",
  "get_skill",
  "get_skill_candidate",
  "get_subscription",
  "get_token_budget",
  "get_user",
  "get_vendor_recipe",
  "get_workflow",
  "inspect_authoring_context",
  "inspect_execution",
  "inspect_execution_step",
  "inspect_recipe",
  "inspect_role",
  "inspect_workflow",
  "list_all_skills",
  "list_api_keys",
  "list_attachments",
  "list_audit",
  "list_capability_gaps",
  "list_connectors",
  "list_discovery_artifacts",
  "list_draft_snapshots",
  "list_executions",
  "list_inbound_hooks",
  "list_knowledge_sources",
  "list_patch_candidates",
  "list_portal_tokens",
  "list_recipes",
  "list_roles",
  "list_schedules",
  "list_skill_candidates",
  "list_skill_suggestions",
  "list_skills",
  "list_subscriptions",
  "list_system_accounts",
  "list_users",
  "list_workflows",
  "match_connector_template_by_url",
  "preview_attachment",
  "preview_patch_candidate",
  "probe_connector",
  "propose_schema_migration",
  "run_workflow",
  "search_docs",
  "search_knowledge",
  "search_knowledge_v2",
  "suggest_connector_templates",
  "suggest_jsonata_paths",
  "suggest_related_conversations",
  "test_connector",
  "test_rbac_expression",
  "whoami",
];

const ADMIN_TOOLS = [
  "analyze_knowledge_source",
  "analyze_scrape_target",
  "approve_discovery_artifact",
  "approve_patch_candidate",
  "approve_skill_candidate",
  "authenticate",
  "authenticate_oauth",
  "call_connector",
  "cannot_help",
  "conversation_append",
  "conversation_commit",
  "conversation_get",
  "conversation_respond_elicitation",
  "conversation_start",
  "create_api_key",
  "create_knowledge_source",
  "create_schedule",
  "create_skill",
  "delete_connector",
  "delete_knowledge_source",
  "delete_schedule",
  "delete_skill",
  "delete_subscription",
  "delete_workflow",
  "discover_connector_endpoints",
  "discover_systems_from_files",
  "dry_run_patch_candidate",
  "dry_run_transform",
  "edit_role",
  "fetch_connector_docs",
  "fetch_connector_self_description",
  "find_connector",
  "find_role",
  "find_skill",
  "find_user",
  "find_workflow",
  "get_api_key",
  "get_audit_entry",
  "get_connector",
  "get_discovery_artifact",
  "get_engine_status",
  "get_execution",
  "get_inbound_hook",
  "get_knowledge_source",
  "get_llm_usage",
  "get_patch_candidate",
  "get_raw_result",
  "get_role",
  "get_skill",
  "get_skill_candidate",
  "get_subscription",
  "get_token_budget",
  "get_user",
  "get_vendor_recipe",
  "get_workflow",
  "import_connector_from_spec",
  "inspect_authoring_context",
  "inspect_execution",
  "inspect_execution_step",
  "inspect_recipe",
  "inspect_role",
  "inspect_workflow",
  "list_all_skills",
  "list_api_keys",
  "list_attachments",
  "list_audit",
  "list_capability_gaps",
  "list_connectors",
  "list_discovery_artifacts",
  "list_draft_snapshots",
  "list_executions",
  "list_inbound_hooks",
  "list_knowledge_sources",
  "list_patch_candidates",
  "list_portal_tokens",
  "list_recipes",
  "list_roles",
  "list_schedules",
  "list_skill_candidates",
  "list_skill_suggestions",
  "list_skills",
  "list_subscriptions",
  "list_system_accounts",
  "list_users",
  "list_workflows",
  "load_skill",
  "match_connector_template_by_url",
  "preview_attachment",
  "preview_patch_candidate",
  "probe_connector",
  "propose_schema_migration",
  "rerun_execution",
  "revoke_api_key",
  "revoke_portal_token",
  "run_workflow",
  "save_connector_draft",
  "search_docs",
  "search_knowledge",
  "search_knowledge_v2",
  "self_healing_scan",
  "suggest_connector_templates",
  "suggest_jsonata_paths",
  "suggest_related_conversations",
  "test_connector",
  "test_rbac_expression",
  "update_connector",
  "update_knowledge_source",
  "update_schedule",
  "update_skill",
  "update_subscription",
  "update_workflow",
  "whoami",
];

describe("mcp tools/list catalog snapshot", () => {
  test("product mode (no mcp:* scope) catalog is pinned exactly", async () => {
    const { plaintext } = await suite.issueApiKey(["workflow:read"]);
    expect(await staticToolNames(plaintext)).toEqual(PRODUCT_TOOLS);
  });

  test("authoring mode (mcp:authoring) catalog is pinned exactly", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:authoring"]);
    expect(await staticToolNames(plaintext)).toEqual(AUTHORING_TOOLS);
  });

  test("admin mode (mcp:admin) catalog is pinned exactly", async () => {
    const { plaintext } = await suite.issueApiKey(["mcp:admin"]);
    expect(await staticToolNames(plaintext)).toEqual(ADMIN_TOOLS);
  });

  test("mode hierarchy stays monotone: product ⊆ authoring ⊆ admin", () => {
    for (const name of PRODUCT_TOOLS) expect(AUTHORING_TOOLS).toContain(name);
    for (const name of AUTHORING_TOOLS) expect(ADMIN_TOOLS).toContain(name);
  });
});
