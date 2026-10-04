export function parseScopeList(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
}

export function storedScopes(value: string): string;
export function storedScopes(value: string | null): string | null;
export function storedScopes(value: string | null): string | null {
  return value === null ? null : parseScopeList(value).join(" ");
}

export function sameAuthorityScopes(left: string | null, right: string | null): boolean {
  return JSON.stringify(authorityScopeSet(left)) === JSON.stringify(authorityScopeSet(right));
}

export function authorityScopeSet(value: string | null): string[] | null {
  return value === null ? null : parseScopeList(value).sort();
}
