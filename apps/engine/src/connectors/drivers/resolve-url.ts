// How a connector-relative path becomes the URL that is actually dispatched.
//
// A leaf module on purpose. The HTTP driver uses it to send a request, and the
// authority review uses it to decide what target a human is approving — and
// those two MUST be the same function. Reviewing a target with `new URL(path,
// base)` while dispatching through this resolver disagrees for every connector
// whose base_url carries a path: the review drops the base path, dispatch keeps
// it, and a grant is approved for a URL the run can never produce. Living here
// (not in `http.ts`) lets the workflow layer import it without pulling in the
// driver and the import cycle that comes with it.

export function isAbsoluteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/**
 * Resolve the final URL for a request relative to a connector's
 * base_url. If the input is already absolute, the base_url is ignored.
 *
 * Two real-world authoring patterns must BOTH resolve correctly against a
 * base with a non-root pathname (e.g. base="https://api.example.com/v1"):
 *
 *   1. path WITHOUT the base prefix:  "/users/me" or "users/me"
 *   2. path WITH the base prefix:     "/v1/users/me" or "v1/users/me"
 *
 * The bare URL spec mishandles both: `new URL("/users/me", base)` drops the
 * "/v1" prefix (404), while naively appending "/v1/users/me" doubles it to
 * "/v1/v1/users/me" (also 404). We normalize by (a) treating the path as
 * relative (strip a leading "/") so it appends to — not replaces — the base
 * pathname, and (b) stripping a duplicated leading base-pathname segment so
 * an author who already included the prefix does not double it. Both
 * patterns therefore land on "https://api.example.com/v1/users/me".
 *
 * Absolute URLs (https?://) short-circuit. Base URLs with root pathname
 * ("/") have no prefix to preserve or dedupe, so they pass through.
 */
export function resolveUrl(base_url: string | null, path_or_url: string): URL {
  if (isAbsoluteUrl(path_or_url)) return new URL(path_or_url);
  const base = base_url ?? "";
  if (!base) {
    throw new Error(
      `HTTP driver: no base_url on connector and path "${path_or_url}" is not absolute`,
    );
  }
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  // Base pathname without surrounding slashes, e.g. "/v1/" → "v1",
  // "/gmail/v1/" → "gmail/v1", "/" → "".
  const basePrefix = new URL(normalizedBase).pathname.replace(/^\/+|\/+$/g, "");
  // Treat the path as relative so it appends to the base pathname instead of
  // replacing it (the URL-spec drop bug).
  let effectivePath = path_or_url.replace(/^\/+/, "");
  // Dedupe: if the author already prefixed the base pathname, strip it so the
  // relative join below does not double it.
  if (basePrefix && (effectivePath === basePrefix || effectivePath.startsWith(`${basePrefix}/`))) {
    effectivePath = effectivePath.slice(basePrefix.length).replace(/^\/+/, "");
  }
  return new URL(effectivePath, normalizedBase);
}
