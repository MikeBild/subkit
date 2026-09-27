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
  if (path.startsWith(`${BASE}/`) || path === BASE) return path;
  return path === "/" ? BASE : `${BASE}${path}`;
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
  } = {},
): string {
  return withQuery("/runs", {
    workflow_id: filter.workflowId,
    status: filter.status === "all" ? null : filter.status,
    source: filter.source === "all" ? null : filter.source,
    q: filter.q,
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
 * score counts against: enabled and not `ok` (connectors-model.ts owns the rule).
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

/** The four decision tiles on the overview, each a filter on the queue. */
export type DecisionBucket = "blocked" | "failing" | "overdue" | "other";

export function decisionsHref(
  filter: { bucket?: DecisionBucket | null; workflowId?: string | null } = {},
): string {
  return withQuery("/decisions", { bucket: filter.bucket, workflow_id: filter.workflowId });
}

/** The settings page, opened at one leaf (`server.public_base_url`). */
export function settingsHref(leaf?: string | null): string {
  return withQuery("/settings", { leaf });
}

export function auditHref(
  filter: {
    resourceType?: string | null;
    resourceId?: string | null;
    traceId?: string | null;
    scope?: "all" | "decisions" | "operations" | null;
    /** The engine's verbs, sent as its own comma list. */
    actions?: readonly string[] | null;
  } = {},
): string {
  return withQuery("/audit", {
    resource_type: filter.resourceType,
    resource_id: filter.resourceId,
    trace_id: filter.traceId,
    scope: filter.scope,
    action: filter.actions && filter.actions.length > 0 ? filter.actions.join(",") : null,
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

export function apiAccessHref(section?: string | null): string {
  return withQuery("/api-access", { section });
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

/** A record id from the address, where the engine only takes a UUID. */
export function uuidParam(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key)?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
}
