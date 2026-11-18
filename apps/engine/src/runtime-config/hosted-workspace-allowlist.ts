import { settingSecretName } from "./secret-reference.ts";

export const HOSTED_WORKSPACE_ALLOWLIST = {
  settings: ["llm.provider", "llm.model", "llm.api_key"],
  secrets: ["llm.api_key"],
} as const;

export type HostedWorkspaceSetting = (typeof HOSTED_WORKSPACE_ALLOWLIST.settings)[number];

export function hostedWorkspaceSecretAllowed(name: string, tenantId: string): boolean {
  return HOSTED_WORKSPACE_ALLOWLIST.secrets.some(
    (leaf) => name === settingSecretName(tenantId, leaf.split(".")),
  );
}

function leafPaths(value: unknown, prefix: string[]): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix.join(".")];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    child === undefined ? [] : leafPaths(child, [...prefix, key]),
  );
}

export function hostedWorkspaceOverlayViolations(overlay: unknown): string[] {
  const allowed: readonly string[] = HOSTED_WORKSPACE_ALLOWLIST.settings;
  const held = leafPaths(overlay, []).filter((path) => path !== "");
  const foreign = held.filter((path) => !allowed.includes(path));
  if (foreign.length > 0 || held.length === 0) return foreign;
  const llm = (overlay as { llm?: { provider?: unknown; api_key?: unknown } }).llm;
  const complete =
    typeof llm?.provider === "string" && typeof llm.api_key === "string" && llm.api_key !== "";
  return complete ? [] : ["llm.api_key"];
}
