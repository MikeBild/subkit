export interface CatalogQueryState {
  q: string;
  status: string;
  category: string;
  connector: string;
  health: "not_ok" | null;
  sort: string;
  order: "asc" | "desc";
  page: number;
}

export function catalogListParams(
  resource: string,
  state: CatalogQueryState,
  pageSize: number,
): URLSearchParams {
  const params = new URLSearchParams({
    limit: String(pageSize),
    offset: String(state.page * pageSize),
    sort: state.sort,
    order: state.order,
  });
  if (state.q) params.set("q", state.q);
  if (state.category !== "all") params.set("category", state.category);
  if (resource === "workflows" && state.connector) params.set("connector", state.connector);
  if (resource === "connectors" && state.health === "not_ok") params.set("health", "not_ok");
  if (state.status !== "all") {
    if (resource === "connectors") {
      if (state.status === "enabled" || state.status === "disabled") {
        params.set("enabled", String(state.status === "enabled"));
      } else {
        params.set("health_state", state.status);
      }
    } else {
      params.set("status", state.status);
    }
  }
  return params;
}

export type RecordValue = Record<string, unknown>;

export function recordPurpose(record: RecordValue | undefined): string | null {
  const value = record?.description;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function recordTitle(record: RecordValue | undefined): string {
  for (const key of ["name", "display_name", "title", "filename", "slug"]) {
    const value = record?.[key];
    if (typeof value === "string" && value) return value;
  }
  return "—";
}
