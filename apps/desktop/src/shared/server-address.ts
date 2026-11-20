export type AddressProblem = "empty" | "invalid" | "insecure" | "credentials";

export type AddressResult = { ok: true; origin: string } | { ok: false; problem: AddressProblem };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return (
    LOOPBACK_HOSTS.has(hostname.toLowerCase()) || hostname.toLowerCase().endsWith(".localhost")
  );
}

export function normalizeServerAddress(input: string): AddressResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, problem: "empty" };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const bareLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `${bareLoopback ? "http" : "https"}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, problem: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, problem: "invalid" };
  if (!url.hostname) return { ok: false, problem: "invalid" };
  if (url.username || url.password) return { ok: false, problem: "credentials" };
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return { ok: false, problem: "insecure" };
  }
  return { ok: true, origin: url.origin };
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isSameOrigin(raw: string, serverOrigin: string): boolean {
  const url = parse(raw);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return false;
  if (url.username || url.password) return false;
  return url.origin === serverOrigin;
}

export function isExternallyOpenable(raw: string): boolean {
  const url = parse(raw);
  if (!url) return false;
  if (url.protocol === "mailto:") return true;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

export type NavigationDecision = "allow" | "external" | "deny";

export function decideNavigation(raw: string, serverOrigin: string): NavigationDecision {
  if (isSameOrigin(raw, serverOrigin)) return "allow";
  return isExternallyOpenable(raw) ? "external" : "deny";
}

export function safeServerPath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  if (/\s/.test(value) || [...value].some((char) => char.charCodeAt(0) < 32)) return fallback;
  const url = parse(`https://subkit.invalid${value}`);
  if (url?.origin !== "https://subkit.invalid") return fallback;
  return `${url.pathname}${url.search}`;
}

const COCKPIT_ROOT = "/cockpit";

function splitFragment(href: string): [string, string] {
  const at = href.indexOf("#");
  if (at < 0) return [href, ""];
  const fragment = href.slice(at + 1);
  return [href.slice(0, at), /^[A-Za-z0-9_.~-]{1,128}$/.test(fragment) ? `#${fragment}` : ""];
}

export function cockpitUrl(
  serverOrigin: string,
  cockpitPath: string,
  href?: string | null,
): string {
  const base = safeServerPath(cockpitPath, COCKPIT_ROOT);
  const root = `${serverOrigin}${base}`;
  if (!href) return root;
  const [path, fragment] = splitFragment(href);
  const route = safeServerPath(path, "");
  if (!route) return root;
  const prefix = base.endsWith("/") ? base.slice(0, -1) : base;
  const inside = (candidate: string, parent: string) =>
    candidate === parent ||
    candidate.startsWith(`${parent}/`) ||
    candidate.startsWith(`${parent}?`);
  const target = inside(route, prefix)
    ? route
    : inside(route, COCKPIT_ROOT) && !inside(route, `${COCKPIT_ROOT}/i`)
      ? `${prefix}${route.slice(COCKPIT_ROOT.length)}`
      : `${prefix}${route}`;
  const resolved = `${serverOrigin}${target}${fragment}`;
  return isSameOrigin(resolved, serverOrigin) ? resolved : root;
}
