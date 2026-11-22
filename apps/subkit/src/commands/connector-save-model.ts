export type ConnectorCheckPlan = "skip" | "defer_mcp_probe" | "probe_draft" | "validate_only";

export function connectorCheckPlan(
  action: "create" | "patch",
  driver: unknown,
  skipChecks: boolean,
): ConnectorCheckPlan {
  if (skipChecks) return "skip";
  if (action === "patch") return "validate_only";
  return driver === "mcp" ? "defer_mcp_probe" : "probe_draft";
}
