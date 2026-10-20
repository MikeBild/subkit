const INSTALLATION_PATH =
  /^\/cockpit\/i\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/|$)/i;

export function installationId(pathname = currentPathname()): string | null {
  return INSTALLATION_PATH.exec(pathname)?.[1] ?? null;
}

function currentPathname(): string {
  return typeof window === "undefined" ? "/cockpit" : window.location.pathname;
}

export function cockpitBasePath(pathname = currentPathname()): string {
  const id = installationId(pathname);
  return id ? `/cockpit/i/${id}` : "/cockpit";
}

export function cockpitApiHref(path: string, pathname = currentPathname()): string {
  if (!/^\/v1(?:\/|\?|$)/.test(path)) return path;
  const id = installationId(pathname);
  return id ? `/cockpit/i/${id}/api${path}` : path;
}

export function contextualHref(path: string, pathname = currentPathname()): string {
  if (/^\/v1(?:\/|\?|$)/.test(path)) return cockpitApiHref(path, pathname);
  const base = cockpitBasePath(pathname);
  if (path === "/cockpit") return base;
  if (path.startsWith("/cockpit/") && !path.startsWith("/cockpit/i/"))
    return `${base}${path.slice("/cockpit".length)}`;
  return path;
}
