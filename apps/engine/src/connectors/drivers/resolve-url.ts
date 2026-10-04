export function isAbsoluteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export function resolveUrl(base_url: string | null, path_or_url: string): URL {
  if (isAbsoluteUrl(path_or_url)) return new URL(path_or_url);
  const base = base_url ?? "";
  if (!base) {
    throw new Error(
      `HTTP driver: no base_url on connector and path "${path_or_url}" is not absolute`,
    );
  }
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const basePrefix = new URL(normalizedBase).pathname.replace(/^\/+|\/+$/g, "");
  let effectivePath = path_or_url.replace(/^\/+/, "");
  if (basePrefix && (effectivePath === basePrefix || effectivePath.startsWith(`${basePrefix}/`))) {
    effectivePath = effectivePath.slice(basePrefix.length).replace(/^\/+/, "");
  }
  return new URL(effectivePath, normalizedBase);
}
