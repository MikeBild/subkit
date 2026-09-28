// Outbound connections — which scopes are permissions and which are protocol.
//
// A person picks permissions ("read", "write", …): what the other side may let
// this engine do. `offline_access` is not one of them. It is how an OpenID
// Connect server is asked for a refresh token (OIDC Core §11), and a server
// that advertises it issues no refresh token without it — the grant then ends
// after its first access-token lifetime and can never renew itself.
//
// So the engine requests it on its own whenever the server advertises it, and
// it never reaches the person as something to choose or as something granted.

import type { AuthorizationServerMetadata } from "./types.ts";

/** The OIDC scope that asks for a refresh token. */
export const OFFLINE_ACCESS_SCOPE = "offline_access";

/** The scopes a person grants — protocol scopes removed, blanks and duplicates dropped. */
export function permissionScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((s) => s.trim()).filter((s) => s && s !== OFFLINE_ACCESS_SCOPE))];
}

/**
 * Whether this server issues refresh tokens only when asked for them with
 * `offline_access`: it lists the scope, and does not rule out the
 * refresh_token grant.
 */
export function wantsOfflineAccess(metadata: AuthorizationServerMetadata): boolean {
  if (!metadata.scopes_supported?.includes(OFFLINE_ACCESS_SCOPE)) return false;
  const grants = metadata.grant_types_supported;
  return !grants || grants.includes("refresh_token");
}

/**
 * The scope set sent to the server — at registration and in the
 * authorization request: the person's permissions, plus `offline_access`
 * when this server needs it to issue a refresh token. Derived from the
 * metadata read on this round, so a renewal asks for it too even when the
 * first round did not.
 */
export function requestedScopes(
  permissions: readonly string[],
  metadata: AuthorizationServerMetadata,
): string[] {
  const scopes = permissionScopes(permissions);
  return wantsOfflineAccess(metadata) ? [...scopes, OFFLINE_ACCESS_SCOPE] : scopes;
}
