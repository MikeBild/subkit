import { WILDCARD_SCOPE } from "../../auth/scopes.ts";

export function exceedsMessage(scopes: string[], operatorOnly: string[]): string {
  if (scopes.includes(WILDCARD_SCOPE)) {
    return "Only a credential without scope limits can issue '*'. List the permissions the key needs instead.";
  }
  const first = operatorOnly[0];
  if (first && operatorOnly.length === scopes.length) {
    return `${operatorOnly.join(", ")} affects the whole engine; only the engine operator can grant it.`;
  }
  const base = `You cannot grant ${scopes.join(", ")} because your own credential does not hold it. Request only scopes you hold, or ask an admin who holds them.`;
  return first
    ? `${base} ${operatorOnly.join(", ")} affects the whole engine; only the engine operator can grant it.`
    : base;
}

export function isUnbounded(
  principal: Readonly<{ product_id?: string | null; provider: string; scopes?: readonly string[] }>,
): boolean {
  if (principal.product_id) return false;
  if (principal.provider === "portal_token") return false;
  const scopes = principal.scopes;
  return scopes === undefined || scopes.length === 0 || scopes.includes(WILDCARD_SCOPE);
}

export function storedScopes(scopes: string[] | null | undefined): string[] {
  return scopes && scopes.length > 0 ? [...new Set(scopes)] : [WILDCARD_SCOPE];
}
