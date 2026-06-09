// Registry of conversation tools whose side effects cannot be reversed
// from within the conversation. Membership is treated as a hard
// constraint by the policy resolver: dangerous tools stay on
// `confirm_before_execution` even when the client requests `permission:
// auto` for the turn.
//
// Lifted out of `tool-policies.ts` so the policy resolver, the RBAC
// surface, and any future audit-coverage check can read from a single
// source. A test in `tests/dangerous-tools-rbac.test.ts` asserts that
// every entry here has a matching `*:write` (or stronger) RBAC
// permission, so a refactor that adds a new dangerous tool can't slip
// past without authorisation.

export const DANGEROUS_TOOLS = [
  "delete_workflow",
  "delete_connector",
  "delete_knowledge_source",
  "delete_subscription",
  "revoke_api_key",
  "revoke_portal_token",
  "approve_patch_candidate",
  "approve_skill_candidate",
  "approve_discovery_artifact",
] as const;

export type DangerousTool = (typeof DANGEROUS_TOOLS)[number];

export const DANGEROUS_TOOLS_SET: ReadonlySet<string> = new Set(DANGEROUS_TOOLS);

/** True if `name` is on the dangerous-tools list, OR is an external MCP
 *  tool (`mcp_<ns>__<tool>`). The policy resolver treats `true` as an
 *  unconditional confirm-before-execution gate under auto/ask/plan: an
 *  external MCP tool leaves the tenant perimeter to a third-party server,
 *  so it asks before running by default (the exact-name set stays the
 *  source of truth for the in-repo destructive tools). */
export function isDangerousTool(name: string): boolean {
  return DANGEROUS_TOOLS_SET.has(name) || name.startsWith("mcp_");
}
