import { parseScopeList } from "../authority-scopes.ts";
import type { AuthorizationServerMetadata } from "./types.ts";

export const OFFLINE_ACCESS_SCOPE = "offline_access";

export function permissionScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.flatMap(parseScopeList).filter((s) => s !== OFFLINE_ACCESS_SCOPE))];
}

function wantsOfflineAccess(metadata: AuthorizationServerMetadata): boolean {
  if (!metadata.scopes_supported?.includes(OFFLINE_ACCESS_SCOPE)) return false;
  const grants = metadata.grant_types_supported;
  return !grants || grants.includes("refresh_token");
}

export function requestedScopes(
  permissions: readonly string[],
  metadata: AuthorizationServerMetadata,
): string[] {
  const scopes = permissionScopes(permissions);
  return wantsOfflineAccess(metadata) ? [...scopes, OFFLINE_ACCESS_SCOPE] : scopes;
}
