/** OAuth scope tokens are case-sensitive sets. Missing scope information is
 * distinct from an explicitly empty grant. Formatting is not a new grant. */
export function sameAuthorityScopes(left: string | null, right: string | null): boolean {
  return JSON.stringify(authorityScopeSet(left)) === JSON.stringify(authorityScopeSet(right));
}

export function authorityScopeSet(value: string | null): string[] | null {
  return value === null ? null : [...new Set(value.split(/\s+/).filter(Boolean))].sort();
}
