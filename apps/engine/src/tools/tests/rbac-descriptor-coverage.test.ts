import { describe, expect, test } from "bun:test";
import { conversationToolProvider } from "../index.ts";
import type { ToolListFilter } from "../registry.ts";

const UNGATED_BY_DESIGN: Readonly<Record<string, readonly string[]>> = {
  "no tenant data": ["whoami", "cannot_help"],

  "self-status by design": ["get_engine_status"],

  "operates on caller-supplied or public input": [
    "analyze_scrape_target",
    "discover_connector_endpoints",
    "discover_systems_from_files",
    "dry_run_transform",
    "fetch_connector_docs",
    "fetch_connector_self_description",
    "match_connector_template_by_url",
    "suggest_connector_templates",
    "suggest_jsonata_paths",
    "test_rbac_expression",
    "search_docs",
    "inspect_recipe",
    "get_vendor_recipe",
    "propose_schema_migration",
    "inspect_authoring_context",
    "load_skill",
  ],

  "known gap — needs a permission": [
    "approve_discovery_artifact",
    "approve_patch_candidate",
    "create_api_key",
    "create_schedule",
    "delete_schedule",
    "dry_run_patch_candidate",
    "find_role",
    "find_skill",
    "find_user",
    "find_workflow",
    "get_discovery_artifact",
    "get_inbound_hook",
    "get_llm_usage",
    "get_patch_candidate",
    "get_raw_result",
    "get_role",
    "get_skill_candidate",
    "get_subscription",
    "get_token_budget",
    "get_workflow",
    "inspect_role",
    "inspect_workflow",
    "list_attachments",
    "list_discovery_artifacts",
    "list_draft_snapshots",
    "list_executions",
    "list_inbound_hooks",
    "list_patch_candidates",
    "list_roles",
    "list_skill_candidates",
    "list_skill_suggestions",
    "list_subscriptions",
    "list_workflows",
    "preview_attachment",
    "preview_patch_candidate",
    "rerun_execution",
    "run_workflow",
    "search_knowledge",
    "update_schedule",
  ],
};

const ALLOWED: ReadonlySet<string> = new Set(Object.values(UNGATED_BY_DESIGN).flat());

function ungatedIn(mcpMode: "product" | "authoring" | "admin"): string[] {
  const filter = { surface: "mcp", mcpMode } as ToolListFilter;
  return conversationToolProvider
    .list(filter)
    .filter((d) => !d.rbac)
    .map((d) => d.name)
    .sort();
}

describe("MCP RBAC descriptor coverage", () => {
  test("no conversation tool reaches MCP ungated without being listed", () => {
    const unexplained = ungatedIn("admin").filter((n) => !ALLOWED.has(n));
    expect(
      unexplained,
      "these tools dispatch on MCP with no permission check — the dispatcher only calls can() when descriptor.rbac is set. Add an RBAC_OVERRIDES entry, declare `permission` on the tool, or list the tool in UNGATED_BY_DESIGN with a reason",
    ).toEqual([]);
  });

  test("every listed exemption is still reachable — the list cannot rot", () => {
    const reachable = new Set(
      conversationToolProvider
        .list({ surface: "mcp", mcpMode: "admin" } as ToolListFilter)
        .map((d) => d.name),
    );
    const stale = [...ALLOWED].filter((n) => !reachable.has(n)).sort();
    expect(
      stale,
      "listed as ungated-by-design but no longer in the admin catalog — remove it",
    ).toEqual([]);
  });

  test("narrower modes cannot be looser than admin", () => {
    const admin = new Set(ungatedIn("admin"));
    for (const mode of ["product", "authoring"] as const) {
      const extra = ungatedIn(mode).filter((n) => !admin.has(n));
      expect(extra, `${mode} mode exposes ungated tools admin does not`).toEqual([]);
    }
  });

  test("the documented ungated count is the one the provider reports", () => {
    const byDesign = Object.entries(UNGATED_BY_DESIGN)
      .filter(([reason]) => !reason.startsWith("known gap"))
      .flatMap(([, names]) => names);
    const knownGap = UNGATED_BY_DESIGN["known gap — needs a permission"] ?? [];

    expect(byDesign.length, "deliberate exemptions").toBe(19);
    expect(knownGap.length, "known gaps still needing a permission").toBe(39);
    expect(ALLOWED.size, "the list has no duplicates across groups").toBe(58);
    expect(ungatedIn("admin").length, "admin catalog, ungated").toBe(58);
    expect(ungatedIn("product").length, "product catalog, ungated").toBe(38);
  });

  test("the audit trail is gated on MCP exactly as it is over HTTP", () => {
    const byName = new Map(
      conversationToolProvider
        .list({ surface: "mcp", mcpMode: "product" } as ToolListFilter)
        .map((d) => [d.name, d]),
    );
    for (const name of ["list_audit", "get_audit_entry"]) {
      expect(byName.get(name)?.rbac?.permission, `${name} must require audit:read`).toBe(
        "audit:read",
      );
    }
  });

  test("persisted connector probes require connector read permission on MCP", () => {
    for (const mcpMode of ["product", "authoring", "admin"] as const) {
      const probe = conversationToolProvider
        .list({ surface: "mcp", mcpMode })
        .find((descriptor) => descriptor.name === "probe_connector");
      expect(probe?.rbac?.permission).toBe("connector:read");
    }
  });

  test("persisted execution steps require execution read permission on MCP", () => {
    for (const mcpMode of ["product", "authoring", "admin"] as const) {
      const inspection = conversationToolProvider
        .list({ surface: "mcp", mcpMode })
        .find((descriptor) => descriptor.name === "inspect_execution_step");
      expect(inspection?.rbac?.permission).toBe("execution:read");
    }
  });
});
