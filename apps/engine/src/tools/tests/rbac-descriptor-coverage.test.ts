// Which MCP-reachable conversation tools reach `execute()` without a `can()`.
//
// The dispatcher's RBAC step is `if (descriptor.rbac)`. No descriptor means no
// permission check at all — not a denial, not a fallback: the step is skipped.
// So a tool that nobody remembered to enter in `RBAC_OVERRIDES` is ungated on
// MCP, silently, and looks exactly like a tool that was deliberately left
// open.
//
// LOCAL-SK-AUDIT-TRAIL-UNGATED — that is how the audit trail shipped open.
// `list_audit` / `get_audit_entry` are the same trail `GET /v1/audit-log`
// serves behind `audit:read`; on MCP they asked nobody. Their neighbours
// (`list_users`, `list_api_keys`, `read_knowledge`) all had entries. It was
// an omission, and nothing in the repo could tell an omission from a choice.
//
// Measured when that was found, against the ADMIN catalog (the widest, 116
// tools): 82 had no `RBAC_OVERRIDES` entry. "Forgotten" was the default, not
// the exception — so a single added entry would have been a fix for one tool
// and no answer at all.
//
// This test is the answer: every ungated tool is listed below WITH a reason,
// and a tool that becomes reachable without a permission fails the suite until
// someone either gates it or writes down why it is open. It is also the
// inventory a future flip of the dispatcher default (no descriptor => deny)
// needs — that flip is a one-line change guarded by this list, and it cannot
// be made safely while the list is unexamined.

import { describe, expect, test } from "bun:test";
import { conversationToolProvider } from "../index.ts";
import type { ToolListFilter } from "../registry.ts";

/** Reachable on MCP in admin mode (the widest catalog) and deliberately
 *  ungated. Each entry needs a reason; grouping is the reason. */
const UNGATED_BY_DESIGN: Readonly<Record<string, readonly string[]>> = {
  // Self-introspection and conversational plumbing — no tenant data.
  // `whoami` must stay open so a principal can discover its own rights
  // before being denied (mirrors rbac/self-introspection.ts).
  "no tenant data": ["whoami", "cannot_help"],

  // Designated low-sensitivity self-status surface: the `enduser` role
  // deliberately lacks `stats:read`, and the sensitive operator health digest
  // is a separate, already gated tool.
  "self-status by design": ["get_engine_status"],

  // Authoring helpers that read the OUTSIDE world (a vendor's docs, a public
  // URL, a spec) or compute over arguments the caller already supplied. They
  // return nothing from the tenant that the caller did not bring.
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
    "probe_connector",
  ],

  // KNOWN GAP — tenant reads and writes with no permission on the MCP path.
  // Not a decision. Each of these returns or changes tenant state and should
  // carry an entry; they are listed so the number is visible rather than
  // implied, and so a NEW one cannot join them unnoticed.
  //
  // Do not add to this group. Add an RBAC_OVERRIDES entry instead, or declare
  // `permission` on the tool (the provider derives a descriptor from it).
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
    "inspect_execution_step",
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
    "run_workflow", // gated by gateWorkflowRunRbac, not by a descriptor
    "search_knowledge",
    "search_knowledge_v2",
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
});
