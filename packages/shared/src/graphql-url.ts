export function looksLikeGraphQLUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase().replace(/\/+$/, "");
    if (/^\/graphql\/v\d+$/.test(path)) return true;
    if (/\/graphql$/.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}
