import { saveProfile } from "./config.ts";
import type { EngineClient } from "./engine-client.ts";

const ROLE_TIER: Record<string, number> = {
  admin: 4,
  operator: 3,
  member: 2,
  portal: 1,
  enduser: 1,
  user: 1,
};

const PERM_TIER: Record<string, number> = {
  "audit:read": 4,
  "system:restart": 4,
  "package:export": 2,
  "package:import": 2,
  "rbac:read": 4,
  "api_key:read": 4,
  "portal_token:read": 4,
  "identity:read": 4,
  "workflow:read": 3,
  "connector:read": 3,
  "connector:write": 3,
  "chat_workspace:read": 3,
  "credential:read": 3,
  "execution:read": 3,
  "notification:read": 3,
  "notification:write": 3,
  "discovery:read": 3,
  "subscription:read": 3,
  "inbound_hook:read": 3,
  "task:read": 2,
  "file:read": 1,
  "file:write": 1,
  "file:delete": 1,
  "mcp:read": 2,
  "skill:read": 2,
  "knowledge:read": 2,
  "conversation:write": 1,
};

export function personaCanSee(
  hint: string | null | undefined,
  requires: string | undefined,
): boolean {
  if (!requires) return true;
  if (!hint || hint === "user" || ROLE_TIER[hint] === undefined) return true;
  return ROLE_TIER[hint] >= (PERM_TIER[requires] ?? 1);
}

export function personaHintForRole(
  roleName: string | null | undefined,
): "admin" | "operator" | "member" | "enduser" | "portal" | null {
  const role = roleName?.toLowerCase();
  if (!role || role === "user") return null;
  if (role === "admin" || role === "operator" || role === "member") return role;
  if (role === "enduser" || role === "portal") return role;
  return null;
}

export async function recordPersonaHint(
  client: EngineClient,
  profileName: string,
  engineUrl: string,
  apiKey: string,
  tenant: string | null,
): Promise<void> {
  try {
    const who = await client.whoami();
    const persona = personaHintForRole(who.role_name);
    if (!persona) return;
    saveProfile({
      name: profileName,
      engine_url: engineUrl,
      api_key: apiKey,
      active_tenant_id: tenant,
      persona_hint: persona,
    });
  } catch {}
}
