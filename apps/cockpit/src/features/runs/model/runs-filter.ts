export const RUNS_FILTER_PARAMS = {
  workflowId: "runs_workflow",
  status: "runs_status",
  source: "runs_source",
  q: "runs_q",
  startedFrom: "runs_from",
  startedTo: "runs_to",
  device: "runs_device",
} as const;

export const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "aborted",
  "timed_out",
  "waiting_for_device",
] as const;

export const REQUEST_SOURCES = [
  "api",
  "cli",
  "mcp",
  "webhook",
  "tool-chain",
  "scheduler",
  "chat",
  "ui",
  "queue",
] as const;

export const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set(["failed", "timed_out", "aborted"]);

export interface RunsFilter {
  status: string;
  q: string;
  source: string;
  workflowId: string | null;
  deviceId: string | null;
  startedFrom: string | null;
  startedTo: string | null;
}

function instantParam(params: URLSearchParams, key: string): string | null {
  const raw =
    params.get(key)?.trim() ??
    // Stryker disable next-line StringLiteral: EQ-RUNS-ABSENT: absent invalid filter sentinel
    "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw))
    return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function uuidParam(params: URLSearchParams, key: string): string | null {
  const raw =
    params.get(key)?.trim() ??
    // Stryker disable next-line StringLiteral: EQ-RUNS-ABSENT: absent invalid filter sentinel
    "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
}

export function isKnownRequestSource(source: string): boolean {
  return (REQUEST_SOURCES as readonly string[]).includes(source);
}

export function filterFromUrl(search: string): RunsFilter {
  const params = new URLSearchParams(search);
  const status =
    params.get(RUNS_FILTER_PARAMS.status) ??
    // Stryker disable next-line StringLiteral: EQ-RUNS-ABSENT: absent invalid filter sentinel
    "";
  const source =
    params.get(RUNS_FILTER_PARAMS.source) ??
    // Stryker disable next-line StringLiteral: EQ-RUNS-ABSENT: absent invalid filter sentinel
    "";
  return {
    status: RUN_STATUSES.includes(status as (typeof RUN_STATUSES)[number]) ? status : "all",
    q: (params.get(RUNS_FILTER_PARAMS.q) ?? "").slice(0, 200),
    source: isKnownRequestSource(source) ? source : "all",
    workflowId: uuidParam(params, RUNS_FILTER_PARAMS.workflowId),
    deviceId: uuidParam(params, RUNS_FILTER_PARAMS.device),
    startedFrom: instantParam(params, RUNS_FILTER_PARAMS.startedFrom),
    startedTo: instantParam(params, RUNS_FILTER_PARAMS.startedTo),
  };
}

export function executionsQuery(
  filter: RunsFilter,
  page: { limit: number; offset: number },
): URLSearchParams {
  const params = new URLSearchParams({ limit: String(page.limit), offset: String(page.offset) });
  if (filter.status !== "all") params.set("status", filter.status);
  if (filter.source !== "all") params.set("request_source", filter.source);
  if (filter.workflowId) params.set("workflow_id", filter.workflowId);
  if (filter.deviceId) params.set("device_id", filter.deviceId);
  if (filter.startedFrom) params.set("started_from", filter.startedFrom);
  if (filter.startedTo) params.set("started_to", filter.startedTo);
  const needle = filter.q.trim();
  if (needle) params.set("q", needle);
  return params;
}

export const RUNS_FILTER_KEYS: readonly string[] = Object.values(RUNS_FILTER_PARAMS);

export function runsFilterSearch(
  search: string,
  filter: Pick<RunsFilter, "status" | "source" | "q">,
): string {
  const params = new URLSearchParams(search);
  const written: [string, string][] = [
    [RUNS_FILTER_PARAMS.status, filter.status === "all" ? "" : filter.status],
    [RUNS_FILTER_PARAMS.source, filter.source === "all" ? "" : filter.source],
    [RUNS_FILTER_PARAMS.q, filter.q.trim()],
  ];
  for (const [key, value] of written) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function failedStatusesFor(status: string): string | null {
  if (status === "all") return [...FAILED_RUN_STATUSES].join(",");
  return FAILED_RUN_STATUSES.has(status) ? status : null;
}

export function runsSheetOpen(search: string): boolean {
  return new URLSearchParams(search).get("runs") === "all";
}

export function runsSheetSearch(search: string, open: boolean): string {
  const params = new URLSearchParams(search);
  if (open) params.set("runs", "all");
  else {
    params.delete("runs");
    for (const key of RUNS_FILTER_KEYS) params.delete(key);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function initialRunsFilter(search: string, now: number): RunsFilter {
  const filter = filterFromUrl(search);
  if (filter.startedFrom || filter.startedTo || filter.workflowId || filter.deviceId) return filter;
  return {
    ...filter,
    startedFrom: new Date(now - 7 * 86_400_000).toISOString(),
    startedTo: new Date(now).toISOString(),
  };
}
