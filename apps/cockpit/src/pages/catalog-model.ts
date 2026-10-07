import type { ListParams } from "@/lib/use-infinite-list";

export interface CatalogQueryState {
  q: string;
  status: string;
  category: string;
  connector: string;
  health: "not_ok" | null;
  sort: string;
  order: "asc" | "desc";
}

export function catalogListParams(resource: string, state: CatalogQueryState): ListParams {
  const params: ListParams = { sort: state.sort, order: state.order };
  if (state.q) params.q = state.q;
  if (state.category !== "all") params.category = state.category;
  if (resource === "workflows" && state.connector) params.connector = state.connector;
  if (resource === "connectors" && state.health === "not_ok") params.health = "not_ok";
  if (resource === "workflows" && state.status !== "all") params.status = state.status;
  return params;
}

export type RecordValue = Record<string, unknown>;

export function recordTitle(record: RecordValue | undefined): string {
  for (const key of ["name", "display_name", "title", "filename", "slug"]) {
    const value = record?.[key];
    if (typeof value === "string" && value) return value;
  }
  return "—";
}
