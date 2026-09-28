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
import { apiAccessHref, attentionHref, peopleHref, uuidParam } from "./links";

export const PAGE_ROUTES = [
  "/",
  "/audit",
  "/usage",
  "/people",
  "/api-access",
  "/notifications",
  "/settings",
] as const;

export type PageRoute = (typeof PAGE_ROUTES)[number];

/**
 * Paths that render no page of their own but must still land somewhere.
 *
 * A redirect is a route a person can type or bookmark, or that a mail, an
 * audit row or an older engine handed out. Each one's target is decided by
 * `legacyTarget`, from the path and the query it arrived with.
 *
 * `/connections` was the Kontoverbindungen page before it became a section of
 * Zugangsdaten. Bookmarks still point there, and an OAuth callback issued
 * before the move lands there with its result in the query — so the query
 * travels with the redirect (`redirectTarget`).
 *
 * `/decisions` and `/operations` were the decisions queue and the system page.
 * Both were a second and third place for what Heute now says once: what needs
 * the reader, and why the installation is not well. Their addresses land on
 * Heute — a link that named one workflow opens that workflow's review sheet.
 *
 * `/access` was the roles, groups and grants page. It is a section of
 * Personen & Rechte now, and its address lands on the roles — what it opened
 * with.
 */
export const REDIRECT_ROUTES = ["/connections", "/decisions", "/operations", "/access"] as const;

export type RedirectRoute = (typeof REDIRECT_ROUTES)[number];

/**
 * Where an old address lands, from its path and its RAW query.
 *
 * `/connections` carries its query along: the page it lands on reads the
 * OAuth callback's result out of it. `/access` does too, under the section it
 * lands on — its own `section` wins, whatever the old address said. The decisions queue's `bucket` narrowed a
 * page that no longer exists — carried along, it would only sit in Heute's
 * address meaning nothing. `workflow_id` is the one thing an old decisions
 * link said that still has a place, and it has to be a UUID to get there.
 */
export function legacyTarget(path: RedirectRoute, search: string): string {
  if (path === "/connections") return redirectTarget(apiAccessHref("grants"), search);
  if (path === "/access") return redirectTarget(peopleHref("roles"), search);
  if (path === "/decisions") {
    const workflowId = uuidParam(new URLSearchParams(search), "workflow_id");
    return workflowId ? attentionHref({ review: `workflow:${workflowId}` }) : attentionHref();
  }
  return attentionHref();
}

/**
 * Where a redirect lands, with the query it arrived with. The target's own
 * parameters win (a `section` the old address cannot override); everything
 * else the address carried — `connected`, `renewed`, `failed`, `name` — is
 * kept verbatim, because the page it lands on reads them.
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

/**
 * The run log, and one run by id.
 *
 * `/runs` had a list and nothing else. Its detail sheet opened from local
 * state, so a single run had no address: an audit row, a decision or a metric
 * that named one run could point at the list and no further, and every
 * `/runs/<id>` anyone built landed on "page not found".
 *
 * Two reasons this is its own group rather than two entries elsewhere.
 *
 * Not in CATALOG_RESOURCES: that list generates the generic catalogue PAIR —
 * `CatalogPage` and `CatalogDetailPage`, both keyed by `DetailResource`, whose
 * ENDPOINTS, PERMISSIONS and DESCRIPTION_KEYS maps have no entry for runs. A
 * run also gets no second surface: both paths render the same page and the id
 * selects the row whose sheet is already there, because two detail views of
 * one record are two places to keep in step.
 *
 * Not in PAGE_ROUTES either, for the reason written above `CHAT_ROUTES`' own
 * destructuring in `router.tsx`: the router MAPS over PAGE_ROUTES, a mapped
 * tuple collapses to the union of its members, and one parameterised member
 * makes `params` a required prop on every `<Link to="…">` aimed at any of
 * them. The typecheck says so out loud — `to="/runs"` and `to="/audit"` both
 * stopped compiling while this pair lived there.
 */
export const RUN_ROUTES = ["/runs", "/runs/$resourceId"] as const;

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
  ...RUN_ROUTES,
  ...CATALOG_RESOURCES.flatMap((resource) => [`/${resource}`, `/${resource}/$resourceId`]),
];
