import { DEFAULT_STATS_WINDOW, type StatsWindow } from "@/lib/stats-window";
import { cockpitBasePath } from "./installation-context";
import type { RecordResource } from "./route-table";

export function absolute(path: string): string {
  const BASE = cockpitBasePath();
  if (
    BASE !== "/cockpit" &&
    (path === "/cockpit" || (path.startsWith("/cockpit/") && !path.startsWith("/cockpit/i/")))
  )
    return `${BASE}${path.slice("/cockpit".length)}`;
  if (path === BASE || path.startsWith(`${BASE}/`) || path.startsWith(`${BASE}?`)) return path;
  if (path === "/") return BASE;
  if (path.startsWith("/?")) return `${BASE}${path.slice(1)}`;
  return `${BASE}${path}`;
}

export function routerPath(href: string): string {
  const BASE = cockpitBasePath();
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

export const RUNS_FILTER_PARAMS = {
  workflowId: "runs_workflow",
  status: "runs_status",
  source: "runs_source",
  q: "runs_q",
  startedFrom: "runs_from",
  startedTo: "runs_to",
} as const;

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
    [RUNS_FILTER_PARAMS.workflowId]: filter.workflowId,
    [RUNS_FILTER_PARAMS.status]: filter.status === "all" ? null : filter.status,
    [RUNS_FILTER_PARAMS.source]: filter.source === "all" ? null : filter.source,
    [RUNS_FILTER_PARAMS.q]: filter.q,
    [RUNS_FILTER_PARAMS.startedFrom]: filter.startedFrom,
    [RUNS_FILTER_PARAMS.startedTo]: filter.startedTo,
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

export const WORKFLOW_RUN_ANCHOR = "workflow-run";

export function workflowRunHref(id: string): string {
  return `${workflowHref(id)}#${WORKFLOW_RUN_ANCHOR}`;
}

export function connectorHref(id: string): string {
  return record("connectors", id);
}

export function connectorsHref(filter: { health?: "not_ok" | null } = {}): string {
  return withQuery("/connectors", { health: filter.health });
}

export function skillCandidatesHref(): string {
  return "/skills/candidates";
}

export function recordHref(resource: RecordResource, id: string): string {
  return record(resource, id);
}

export function workflowsHref(
  filter: { connector?: string | null; operatingStatus?: "repair_required" | null } = {},
): string {
  return withQuery("/workflows", {
    connector: filter.connector,
    operating_status: filter.operatingStatus,
  });
}

export function conversationHref(id: string): string {
  return record("chat", id);
}

export function docsHref(slug?: string | null, anchor?: string | null): string {
  const path = slug ? record("docs", slug) : "/docs";
  return anchor ? `${path}#${encodeURIComponent(anchor)}` : path;
}

export function attentionHref(filter: { review?: string | null } = {}): string {
  return filter.review ? `/?review=${filter.review}` : "/";
}

export function reviewFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get("review")?.trim() ?? "";
  if (!raw || raw.length > 200 || !/^[\w.:@-]+$/.test(raw)) return null;
  return raw;
}

export function usageHref(filter: { window?: StatsWindow | null } = {}): string {
  return withQuery("/usage", {
    window: filter.window === DEFAULT_STATS_WINDOW ? null : filter.window,
  });
}

export function settingsHref(
  leaf?: string | null,
  view: {
    section?: string | null;
    filter?: "changed" | null;
    area?: string | null;
    all?: boolean;
  } = {},
): string {
  return withQuery("/settings", {
    leaf,
    section: view.section,
    filter: view.filter,
    area: view.area,
    view: view.all && !leaf && !view.section && !view.filter ? "all" : null,
  });
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

export const CHAT_REFERENCE_TYPES = [
  "workflow",
  "connector",
  "skill",
  "knowledge_source",
  "execution",
  "intake_item",
] as const;

export type ChatReferenceSeed = {
  type: (typeof CHAT_REFERENCE_TYPES)[number];
  id: string;
};

function chatReferenceSeedValue(
  references: readonly ChatReferenceSeed[] | null | undefined,
): string | null {
  const unique = new Set<string>();
  for (const reference of references ?? []) {
    if (!CHAT_REFERENCE_TYPES.includes(reference.type)) continue;
    if (!/^[0-9a-f-]{36}$/i.test(reference.id)) continue;
    unique.add(`${reference.type}:${reference.id}`);
  }
  return unique.size ? [...unique].join(",") : null;
}

function chatReferenceSeeds(raw: string): ChatReferenceSeed[] {
  const unique = new Set<string>();
  return raw.split(",").flatMap((value) => {
    const [type, id, ...rest] = value.split(":");
    if (rest.length || !type || !id) return [];
    if (!CHAT_REFERENCE_TYPES.includes(type as ChatReferenceSeed["type"])) return [];
    if (!/^[0-9a-f-]{36}$/i.test(id)) return [];
    const key = `${type}:${id}`;
    if (unique.has(key)) return [];
    unique.add(key);
    return [{ type: type as ChatReferenceSeed["type"], id }];
  });
}

export function chatNewHref(
  seed: {
    prompt?: string | null;
    workflowId?: string | null;
    connectorId?: string | null;
    executionId?: string | null;
    intakeItemIds?: readonly string[] | null;
    references?: readonly ChatReferenceSeed[] | null;
  } = {},
): string {
  return withQuery("/chat/new", {
    prompt: seed.prompt,
    workflow_id: seed.workflowId,
    connector_id: seed.connectorId,
    execution_id: seed.executionId,
    intake_item_ids: seed.intakeItemIds?.join(","),
    references: chatReferenceSeedValue(seed.references),
  });
}

export function chatSeedFromUrl(search: string): {
  prompt: string;
  workflowId: string | null;
  connectorId: string | null;
  executionId: string | null;
  intakeItemIds: string[];
  references: ChatReferenceSeed[];
} {
  const params = new URLSearchParams(search);
  return {
    prompt: params.get("prompt") ?? "",
    workflowId: params.get("workflow_id") || null,
    connectorId: params.get("connector_id") || null,
    executionId: params.get("execution_id") || null,
    intakeItemIds: (params.get("intake_item_ids") ?? "")
      .split(",")
      .filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
    references: chatReferenceSeeds(params.get("references") ?? ""),
  };
}

export function chatTargetFromUrl(search: string): {
  workflow_id?: string;
  connector_id?: string;
  execution_id?: string;
} {
  const { workflowId, connectorId, executionId } = chatSeedFromUrl(search);
  return {
    ...(workflowId ? { workflow_id: workflowId } : {}),
    ...(connectorId ? { connector_id: connectorId } : {}),
    ...(executionId ? { execution_id: executionId } : {}),
  };
}

export const API_ACCESS_SECTIONS = ["clients", "keys"] as const;
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

export const PEOPLE_SECTIONS = ["people", "roles", "groups", "grants", "apps"] as const;
export type PeopleSection = (typeof PEOPLE_SECTIONS)[number];

export const PEOPLE_APP_PARAM = "app";

export function peopleHref(
  section?: PeopleSection | null,
  filter: { app?: string | null } = {},
): string {
  return withQuery("/people", {
    section: section === "people" ? null : section,
    [PEOPLE_APP_PARAM]: section === "people" || !section ? filter.app : null,
  });
}

export function peopleAppFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get(PEOPLE_APP_PARAM)?.trim() ?? "";
  return raw.length <= 128 && /^[a-z0-9][a-z0-9-]*$/.test(raw) ? raw : null;
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
