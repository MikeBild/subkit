export const DANGEROUS_TOOLS = [
  "delete_workflow",
  "delete_connector",
  "delete_knowledge_source",
  "delete_subscription",
  "revoke_api_key",
  "revoke_portal_token",
  "approve_patch_candidate",
  "approve_skill_candidate",
  "reject_skill_candidate",
  "approve_discovery_artifact",
] as const;

export const DANGEROUS_TOOLS_SET: ReadonlySet<string> = new Set(DANGEROUS_TOOLS);

export function isDangerousTool(name: string): boolean {
  return DANGEROUS_TOOLS_SET.has(name) || name.startsWith("mcp_");
}
