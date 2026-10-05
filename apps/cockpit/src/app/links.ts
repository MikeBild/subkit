import type { CatalogResource } from "./route-table";

const BASE = "/cockpit";

export function absolute(path: string): string {
  if (path === BASE || path.startsWith(`${BASE}/`) || path.startsWith(`${BASE}?`)) return path;
  if (path === "/") return BASE;
  if (path.startsWith("/?")) return `${BASE}${path.slice(1)}`;
  return `${BASE}${path}`;
}

export function routerPath(href: string): string {
  if (href === BASE) return "/";
  if (href.startsWith(`${BASE}?`)) return `/${href.slice(BASE.length)}`;
  if (href.startsWith(`${BASE}/`)) return href.slice(BASE.length);
  return href;
}

export function routerTarget(href: string): {
  to: string;
  search?: Record<string, string>;
  hash?: string;
} {
  const path = routerPath(href);
  const at = path.indexOf("#");
  const hash = at < 0 ? "" : path.slice(at + 1);
  const beforeHash = at < 0 ? path : path.slice(0, at);
  const q = beforeHash.indexOf("?");
  const to = q < 0 ? beforeHash : beforeHash.slice(0, q) || "/";
  const query = q < 0 ? "" : beforeHash.slice(q + 1);
  return {
    to,
    ...(query ? { search: Object.fromEntries(new URLSearchParams(query)) } : {}),
    ...(hash ? { hash } : {}),
  };
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

export function runsHref(
  filter: {
    workflowId?: string | null;
    status?: string | null;
    source?: string | null;
    q?: string | null;
    startedFrom?: string | null;
    startedTo?: string | null;
  } = {},
): string {
  return withQuery("/", {
    runs: "all",
    workflow_id: filter.workflowId,
    status: filter.status === "all" ? null : filter.status,
    source: filter.source === "all" ? null : filter.source,
    q: filter.q,
    started_from: filter.startedFrom,
    started_to: filter.startedTo,
  });
}

export function runHref(id: string): string {
  return withQuery("/", { run: id });
}

export function workflowHref(id: string): string {
  return record("workflows", id);
}

export const WORKFLOW_AUTOMATION_ANCHOR = "workflow-automation";

export function workflowAutomationHref(id: string): string {
  return `${workflowHref(id)}#${WORKFLOW_AUTOMATION_ANCHOR}`;
}

export function connectorHref(id: string): string {
  return record("connectors", id);
}

export function connectorsHref(filter: { health?: "not_ok" | null } = {}): string {
  return withQuery("/connectors", { health: filter.health });
}

export function recordHref(resource: CatalogResource, id: string): string {
  return record(resource, id);
}

export function workflowsHref(filter: { connector?: string | null } = {}): string {
  return withQuery("/workflows", { connector: filter.connector });
}

export function conversationHref(id: string): string {
  return record("chat", id);
}

export function attentionHref(filter: { review?: string | null } = {}): string {
  return filter.review ? `/?review=${filter.review}` : "/";
}

export function reviewFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get("review")?.trim() ?? "";
  if (!raw || raw.length > 200 || !/^[\w.:@-]+$/.test(raw)) return null;
  return raw;
}

export function usageHref(filter: { window?: "24h" | "7d" | "30d" | null } = {}): string {
  return withQuery("/usage", { window: filter.window === "30d" ? null : filter.window });
}

export function settingsHref(
  leaf?: string | null,
  view: { section?: string | null; filter?: "changed" | null } = {},
): string {
  return withQuery("/settings", { leaf, section: view.section, filter: view.filter });
}

export function auditHref(
  filter: {
    resourceType?: string | null;
    resourceId?: string | null;
    traceId?: string | null;
    scope?: "all" | "decisions" | "operations" | null;
    actions?: readonly string[] | null;
    tsFrom?: string | null;
    tsTo?: string | null;
    result?: "success" | "denied" | "error" | null;
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
    result: filter.result,
  });
}

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

export const API_ACCESS_SECTIONS = ["apps", "keys"] as const;
export type ApiAccessSection = (typeof API_ACCESS_SECTIONS)[number];

export function apiAccessHref(section?: ApiAccessSection | null): string {
  return withQuery("/api-access", { section });
}

export function apiAccessSectionFromUrl(search: string): ApiAccessSection | null {
  const raw = new URLSearchParams(search).get("section");
  return (API_ACCESS_SECTIONS as readonly string[]).includes(raw ?? "")
    ? (raw as ApiAccessSection)
    : null;
}

export const PEOPLE_SECTIONS = ["people", "roles", "groups", "grants"] as const;
export type PeopleSection = (typeof PEOPLE_SECTIONS)[number];

export function peopleHref(section?: PeopleSection | null): string {
  return withQuery("/people", { section: section === "people" ? null : section });
}

export function peopleSectionFromUrl(search: string): PeopleSection | null {
  const raw = new URLSearchParams(search).get("section");
  return (PEOPLE_SECTIONS as readonly string[]).includes(raw ?? "") ? (raw as PeopleSection) : null;
}

export function identifierParam(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key)?.trim() ?? "";
  if (!raw || raw.length > 128 || !/^[\w.:-]+$/.test(raw)) return null;
  return raw;
}

export function instantParam(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key)?.trim() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw))
    return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function uuidParam(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key)?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
}
