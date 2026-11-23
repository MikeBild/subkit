export interface BrowserPageRoute {
  method: "GET" | "POST";
  path: string;
}

export const BROWSER_PAGE_ROUTES: readonly BrowserPageRoute[] = [
  { method: "GET", path: "/v1/identity/desktop-login/start" },
  { method: "GET", path: "/v1/identity/desktop-login/confirm" },
  { method: "POST", path: "/v1/identity/desktop-login/confirm" },
  { method: "GET", path: "/v1/identity/cockpit-login" },
  { method: "GET", path: "/v1/identity/login/start" },
  { method: "POST", path: "/v1/identity/login/start" },
  { method: "GET", path: "/v1/identity/login/callback" },
  { method: "GET", path: "/v1/oauth/authorize" },
  { method: "POST", path: "/v1/oauth/authorize/decision" },
  { method: "GET", path: "/v1/oauth/callback" },
  { method: "GET", path: "/v1/connections/callback" },
  { method: "GET", path: "/v1/connectors/mcp/oauth/callback" },
  { method: "GET", path: "/v1/connectors/{id}/oauth/start" },
  { method: "GET", path: "/v1/connectors/{id}/mcp/authorize" },
  { method: "GET", path: "/v1/connectors/{id}/credentials/setup" },
  { method: "POST", path: "/v1/connectors/{id}/credentials/setup" },
  { method: "GET", path: "/v1/connector-drafts/{id}/credentials/setup" },
  { method: "POST", path: "/v1/connector-drafts/{id}/credentials/setup" },
  { method: "GET", path: "/v1/tool-approvals/decide" },
  { method: "POST", path: "/v1/tool-approvals/decide" },
  { method: "GET", path: "/v1/feedback/anonymous/form" },
  { method: "POST", path: "/v1/feedback/anonymous/form" },
];

function routePattern(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) =>
      /^\{.+\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${source}$`);
}

const COMPILED = BROWSER_PAGE_ROUTES.map((route) => ({
  method: route.method,
  pattern: routePattern(route.path),
}));

export function isBrowserPageRoute(method: string, path: string): boolean {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return COMPILED.some((route) => route.method === verb && route.pattern.test(path));
}

export function isBrowserNavigation(headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  const mode = headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  const accept = headers.get("accept") ?? "";
  return accept.includes("text/html");
}
