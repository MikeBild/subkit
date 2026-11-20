import type { AuditEntry } from "./types.ts";

const RESOURCE_NAME_FIELDS: Readonly<Record<string, readonly string[]>> = {
  workflow: ["name"],
  connector: ["display_name", "name"],
  knowledge_source: ["name"],
  skill: ["title", "name"],
  file: ["filename"],
  task: ["name"],
  user: ["email"],
  system_account: ["name"],
  group: ["name"],
  role: ["name"],
  conversation: ["title"],
  mcp_oauth_client: ["client_name"],
};

export function auditResourceName(
  entry: Pick<AuditEntry, "resource_type" | "before" | "after">,
): string | null {
  if (!Object.hasOwn(RESOURCE_NAME_FIELDS, entry.resource_type)) return null;
  const fields = RESOURCE_NAME_FIELDS[entry.resource_type];
  if (!fields) return null;
  for (const snapshot of [entry.after, entry.before]) {
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) continue;
    for (const field of fields) {
      const value = (snapshot as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return null;
}
