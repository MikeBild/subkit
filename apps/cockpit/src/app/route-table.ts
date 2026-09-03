/**
 * Every path this cockpit can render, as data.
 *
 * The conformity sweep used to read its route list from NAVIGATION. That is a
 * right derivation attached to the wrong source: the navigation knows the pages
 * it LINKS to, not the pages that exist. A route reachable only through a menu,
 * a redirect or a direct link was structurally invisible to the check — it
 * could never be found, however often the check ran. WatchKit's account page is
 * the cautionary case; SubKit's `/approvals`, `/chat/new` and `/chat/{id}` are
 * the same shape.
 *
 * So the paths live here and the router builds itself from them. The component
 * map in `router.tsx` is exhaustive over `PAGE_ROUTES`, so a page added without
 * an entry does not compile, and a check that reads this file reads exactly
 * what the router reads.
 */
export const PAGE_ROUTES = [
  "/",
  "/decisions",
  "/runs",
  "/audit",
  "/usage",
  "/people",
  "/access",
  "/api-access",
  "/connections",
  "/notifications",
  "/operations",
  "/settings",
] as const;

export type PageRoute = (typeof PAGE_ROUTES)[number];

/**
 * Paths that render no page of their own but must still land somewhere.
 *
 * A redirect is a route a person can type or bookmark. `/` picks its target
 * from the session's permissions, which is why it has none written down here.
 */
export const REDIRECT_ROUTES: Readonly<Record<string, string | null>> = {};

/** The chat, its new-conversation entry, and one conversation by id. */
export const CHAT_ROUTES = ["/chat", "/chat/new", "/chat/$conversationId"] as const;

/** The catalogues, each with a list page and a detail page. */
export const CATALOG_RESOURCES = [
  "workflows",
  "connectors",
  "knowledge",
  "skills",
  "files",
] as const;

export type CatalogResource = (typeof CATALOG_RESOURCES)[number];

/**
 * Every path the router registers, in one list.
 *
 * Parameterised segments keep their `$name` shape: a caller that wants to visit
 * one has to say which record it means, and a sweep that cannot supply one is
 * expected to report the gap rather than skip it in silence.
 */
export const ALL_ROUTE_PATHS: readonly string[] = [
  ...Object.keys(REDIRECT_ROUTES),
  ...PAGE_ROUTES,
  ...CHAT_ROUTES,
  ...CATALOG_RESOURCES.flatMap((resource) => [`/${resource}`, `/${resource}/$resourceId`]),
];
