// Every address the cockpit builds, in one place.
//
// Builders return ROUTER-RELATIVE paths — `/runs?status=failed`, never
// `/cockpit/runs…`. The router carries `/cockpit` as its base (app/router.tsx),
// so a router `Link` takes a builder's output as it is. Only a raw `<a href>`,
// `window.location.assign` or `history.pushState` needs the base, and gets it
// from `absolute()`.
//
// The split exists because mixing the two shipped a dead link: an absolute
// path handed to a `Link` became `/cockpit/cockpit/runs`, and the one way out
// of a failing decision led to "page not found". Hand-built strings scattered
// over a dozen components are how that happened; a builder is one place to be
// right, and `links.test.ts` holds each one against the parser its page reads
// the address back with.

import type { CatalogResource } from "./route-table";

const BASE = "/cockpit";

/** The router-relative path as a browser address, for `<a href>` and history calls. */
export function absolute(path: string): string {
  if (path === BASE || path.startsWith(`${BASE}/`) || path.startsWith(`${BASE}?`)) return path;
  if (path === "/") return BASE;
  // The start page with a query: `/cockpit?review=…`, never `/cockpit/?review=…`
  // — the router runs with `trailingSlash: "never"`.
  if (path.startsWith("/?")) return `${BASE}${path.slice(1)}`;
  return `${BASE}${path}`;
}

/**
 * An address the ENGINE wrote (`/cockpit?review=…`, `/cockpit/connectors/…`)
 * as a router-relative path. The engine names the cockpit's pages by their
 * browser address; a router `Link` needs them without the base.
 */
export function routerPath(href: string): string {
  if (href === BASE) return "/";
  if (href.startsWith(`${BASE}?`)) return `/${href.slice(BASE.length)}`;
  if (href.startsWith(`${BASE}/`)) return href.slice(BASE.length);
  return href;
}

function withQuery(path: string, entries: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function record(section: string, id: string): string {
  return `/${section}/${encodeURIComponent(id)}`;
}

/** The run log, narrowed. `all` is the page's own word for "no narrowing" and is left out. */
export function runsHref(
  filter: {
    workflowId?: string | null;
    status?: string | null;
    source?: string | null;
    q?: string | null;
    /** A window on when the runs started — the bounds a windowed figure counted over. */
    startedFrom?: string | null;
    startedTo?: string | null;
  } = {},
): string {
  return withQuery("/runs", {
    workflow_id: filter.workflowId,
    status: filter.status === "all" ? null : filter.status,
    source: filter.source === "all" ? null : filter.source,
    q: filter.q,
    started_from: filter.startedFrom,
    started_to: filter.startedTo,
  });
}

export function runHref(id: string): string {
  return record("runs", id);
}

export function workflowHref(id: string): string {
  return record("workflows", id);
}

export function connectorHref(id: string): string {
  return record("connectors", id);
}

/**
 * The connector catalogue. `not_ok` narrows it to the connectors the health
 * score counts against: enabled and not `ok`. The engine owns the rule and
 * answers it (`GET /v1/connectors?health=not_ok`, connectors/health-ratio.ts).
 */
export function connectorsHref(filter: { health?: "not_ok" | null } = {}): string {
  return withQuery("/connectors", { health: filter.health });
}

/** One record of any catalogue — knowledge, skills and files have no builder of their own. */
export function recordHref(resource: CatalogResource, id: string): string {
  return record(resource, id);
}

/** The workflow catalogue, narrowed to the workflows that use one connector. */
export function workflowsHref(filter: { connector?: string | null } = {}): string {
  return withQuery("/workflows", { connector: filter.connector });
}

export function conversationHref(id: string): string {
  return record("chat", id);
}

/**
 * Übersicht — the one list of what needs the reader now — optionally with one
 * entry's review sheet open.
 *
 * The id stays literal (`?review=workflow:<id>`): it is the engine's own item
 * id, the engine writes it that way in every address it hands out, and one
 * spelling is what lets a link, a redirect and a test compare strings. Item
 * ids are `<kind>:<id>` or a bare word — query-safe as they stand.
 */
export function attentionHref(filter: { review?: string | null } = {}): string {
  return filter.review ? `/?review=${filter.review}` : "/";
}

/** The entry whose review sheet an address opens, or none. */
export function reviewFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get("review")?.trim() ?? "";
  if (!raw || raw.length > 200 || !/^[\w.:@-]+$/.test(raw)) return null;
  return raw;
}

/**
 * The settings page, opened at one leaf (`server.public_base_url`), or at a
 * section and a search. `settingsViewFromUrl` in pages/settings-model.ts reads it back.
 */
export function settingsHref(
  leaf?: string | null,
  view: { section?: string | null; q?: string | null; filter?: "changed" | null } = {},
): string {
  return withQuery("/settings", { leaf, section: view.section, q: view.q, filter: view.filter });
}

export function auditHref(
  filter: {
    resourceType?: string | null;
    resourceId?: string | null;
    traceId?: string | null;
    scope?: "all" | "decisions" | "operations" | null;
    /** The engine's verbs, sent as its own comma list. */
    actions?: readonly string[] | null;
    /** A window on when the entries were written (ISO 8601, UTC). */
    tsFrom?: string | null;
    tsTo?: string | null;
  } = {},
): string {
  return withQuery("/audit", {
    resource_type: filter.resourceType,
    resource_id: filter.resourceId,
    trace_id: filter.traceId,
    scope: filter.scope,
    action: filter.actions && filter.actions.length > 0 ? filter.actions.join(",") : null,
    ts_from: filter.tsFrom,
    ts_to: filter.tsTo,
  });
}

/** A new conversation, with its opening prompt and the record it is about. */
export function chatNewHref(
  seed: {
    prompt?: string | null;
    workflowId?: string | null;
    connectorId?: string | null;
    executionId?: string | null;
  } = {},
): string {
  return withQuery("/chat/new", {
    prompt: seed.prompt,
    workflow_id: seed.workflowId,
    connector_id: seed.connectorId,
    execution_id: seed.executionId,
  });
}

/** What a new-conversation address carries, read back. */
export function chatSeedFromUrl(search: string): {
  prompt: string;
  workflowId: string | null;
  connectorId: string | null;
  executionId: string | null;
} {
  const params = new URLSearchParams(search);
  return {
    prompt: params.get("prompt") ?? "",
    workflowId: params.get("workflow_id") || null,
    connectorId: params.get("connector_id") || null,
    executionId: params.get("execution_id") || null,
  };
}

/**
 * The three sections of Zugangsdaten — the one page for everything that holds
 * or grants rights: keys this installation hands out, applications connected
 * to it, and accounts it is connected to.
 */
export const API_ACCESS_SECTIONS = ["keys", "clients", "grants"] as const;
export type ApiAccessSection = (typeof API_ACCESS_SECTIONS)[number];

export function apiAccessHref(section?: ApiAccessSection | null): string {
  return withQuery("/api-access", { section });
}

/** The section an address opens Zugangsdaten at, or none. Anything else is dropped. */
export function apiAccessSectionFromUrl(search: string): ApiAccessSection | null {
  const raw = new URLSearchParams(search).get("section");
  return (API_ACCESS_SECTIONS as readonly string[]).includes(raw ?? "")
    ? (raw as ApiAccessSection)
    : null;
}

/**
 * The four sections of Personen & Rechte — who is here, the roles they hold,
 * the groups they are in, and the grants on single records. One page: who a
 * person is and what they may do were two pages, and a role change on one had
 * its consequence on the other.
 *
 * `grants` here are Freigaben — rights on one workflow or connector. The
 * `grants` section of Zugangsdaten is a different thing (account connections)
 * and keeps its own word.
 */
export const PEOPLE_SECTIONS = ["people", "roles", "groups", "grants"] as const;
export type PeopleSection = (typeof PEOPLE_SECTIONS)[number];

/** Personen & Rechte, at one section. The people list is the default and needs no parameter. */
export function peopleHref(section?: PeopleSection | null): string {
  return withQuery("/people", { section: section === "people" ? null : section });
}

/** The section an address opens Personen & Rechte at, or none. Anything else is dropped. */
export function peopleSectionFromUrl(search: string): PeopleSection | null {
  const raw = new URLSearchParams(search).get("section");
  return (PEOPLE_SECTIONS as readonly string[]).includes(raw ?? "") ? (raw as PeopleSection) : null;
}

/**
 * A plain identifier from the address, or nothing.
 *
 * Bounded and refused when it could not be one: a free-text value forwarded to
 * the engine as an exact match narrows to nothing and reads like an empty list
 * rather than a bad address.
 */
export function identifierParam(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key)?.trim() ?? "";
  if (!raw || raw.length > 128 || !/^[\w.:-]+$/.test(raw)) return null;
  return raw;
}

/**
 * An instant from the address, as the engine takes it (ISO 8601 with its
 * offset), or nothing. A value that is not one is dropped: forwarded, the
 * engine would refuse the whole list for it.
 */
export function instantParam(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key)?.trim() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw))
    return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A record id from the address, where the engine only takes a UUID. */
export function uuidParam(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key)?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
}
