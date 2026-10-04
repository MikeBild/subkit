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

/**
 * Paths that render no page of their own but must still land somewhere.
 *
 * `/access` was the roles, groups and grants page. It is a section of
 * Personen & Rechte now, and its address lands on the roles — what it opened
 * with.
 */
export const REDIRECT_ROUTES = ["/access"] as const;

/**
 * Where a redirect lands, from its path and its RAW query. `/access` carries
 * its query along, under the section it lands on — its own `section` wins,
 * whatever the old address said.
 */
export function movedTarget(search: string): string {
  return redirectTarget(peopleHref("roles"), search);
}

/**
 * Where a redirect lands, with the query it arrived with. The target's own
 * parameters win (a `section` the old address cannot override); everything
 * else the address carried is kept verbatim, because the page it lands on
 * reads it.
 */
export function redirectTarget(target: string, incomingSearch: string): string {
  const [path, own = ""] = target.split("?");
  const params = new URLSearchParams(own);
  for (const [key, value] of new URLSearchParams(incomingSearch)) {
    if (!params.has(key)) params.append(key, value);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : (path ?? "/");
}

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
  ...REDIRECT_ROUTES,
  ...PAGE_ROUTES,
  ...CHAT_ROUTES,
  ...CATALOG_RESOURCES.flatMap((resource) => [`/${resource}`, `/${resource}/$resourceId`]),
];
