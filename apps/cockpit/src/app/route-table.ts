import { peopleHref } from "./links";

export const PAGE_ROUTES = [
  "/",
  "/audit",
  "/usage",
  "/people",
  "/api-access",
  "/settings",
] as const;

export type PageRoute = (typeof PAGE_ROUTES)[number];

export const RECOVERY_ROUTE = "/recovery";

export const STANDALONE_ROUTES = [RECOVERY_ROUTE] as const;

export const REDIRECT_ROUTES = ["/access"] as const;

export function movedTarget(search: string): string {
  return redirectTarget(peopleHref("roles"), search);
}

export function redirectTarget(target: string, incomingSearch: string): string {
  const [path, own = ""] = target.split("?");
  const params = new URLSearchParams(own);
  for (const [key, value] of new URLSearchParams(incomingSearch)) {
    if (!params.has(key)) params.append(key, value);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : (path ?? "/");
}

export const CHAT_ROUTES = ["/chat", "/chat/new", "/chat/$conversationId"] as const;

export const INTAKE_ROUTES = ["/intake", "/intake/$resourceId"] as const;

export const INSTALLATION_ROUTES = ["/incoming/files"] as const;

export const SKILL_CANDIDATE_ROUTES = ["/skills/candidates"] as const;

export const DOCS_ROUTES = ["/docs", "/docs/$slug"] as const;

export const CATALOG_RESOURCES = [
  "workflows",
  "connectors",
  "knowledge",
  "skills",
  "files",
] as const;

export type CatalogResource = (typeof CATALOG_RESOURCES)[number];

export type RecordResource = CatalogResource | "intake";

export const ALL_ROUTE_PATHS: readonly string[] = [
  ...STANDALONE_ROUTES,
  ...REDIRECT_ROUTES,
  ...PAGE_ROUTES,
  ...CHAT_ROUTES,
  ...INTAKE_ROUTES,
  ...INSTALLATION_ROUTES,
  ...SKILL_CANDIDATE_ROUTES,
  ...DOCS_ROUTES,
  ...CATALOG_RESOURCES.flatMap((resource) => [`/${resource}`, `/${resource}/$resourceId`]),
];
