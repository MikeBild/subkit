/**
 * The scope tokens of an OAuth scope string, in order, each once. RFC 6749
 * separates them with spaces; some authorization servers answer with a
 * comma-separated list instead. Both are one list here, at the one place a
 * scope string is read, so a comma-joined grant never reads as a grant of
 * nothing — and never as a different grant than the same set spaced.
 */
export function parseScopeList(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
}

/** The stored form: the scope tokens joined by single spaces (RFC 6749 §3.3).
 *  Null stays null — missing scope information is not an empty grant. */
export function normalizeScopeString(value: string | null): string | null {
  return value === null ? null : parseScopeList(value).join(" ");
}

/** OAuth scope tokens are case-sensitive sets. Missing scope information is
 * distinct from an explicitly empty grant. Formatting is not a new grant. */
export function sameAuthorityScopes(left: string | null, right: string | null): boolean {
  return JSON.stringify(authorityScopeSet(left)) === JSON.stringify(authorityScopeSet(right));
}

export function authorityScopeSet(value: string | null): string[] | null {
  return value === null ? null : parseScopeList(value).sort();
}
