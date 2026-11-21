import { peopleHref } from "./links";

export const PAGE_ROUTES = ["/", "/audit", "/usage", "/api-access", "/settings"] as const;

export type PageRoute = (typeof PAGE_ROUTES)[number];

export const RECOVERY_ROUTE = "/recovery";

export const WELCOME_ROUTE = "/welcome";

export const INVITE_ROUTE = "/invite";

export const STANDALONE_ROUTES = [RECOVERY_ROUTE, WELCOME_ROUTE, INVITE_ROUTE] as const;

export type StandaloneRoute = (typeof STANDALONE_ROUTES)[number];

export const REDIRECT_ROUTES = ["/access"] as const;

export function movedTarget(search: string): string {
  return redirectTarget(peopleHref("roles"), search);
}

function redirectTarget(target: string, incomingSearch: string): string {
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

export const TASK_ROUTES = ["/tasks", "/tasks/$resourceId"] as const;

export const RUN_ROUTE = "/runs/$runId";

const INSTALLATION_ROUTES = ["/incoming/files"] as const;

const SKILL_CANDIDATE_ROUTES = ["/skills/candidates"] as const;

const DOCS_ROUTES = ["/docs", "/docs/$slug"] as const;

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
  ...TASK_ROUTES,
  RUN_ROUTE,
  ...INSTALLATION_ROUTES,
  ...SKILL_CANDIDATE_ROUTES,
  ...DOCS_ROUTES,
  ...CATALOG_RESOURCES.flatMap((resource) => [`/${resource}`, `/${resource}/$resourceId`]),
];
