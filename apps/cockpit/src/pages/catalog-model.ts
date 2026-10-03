// The query a catalogue page sends, from the state its address holds.
//
// Every narrowing is the engine's. The connector list's `?health=not_ok` used to
// be the exception: the page read 200 enabled connectors and filtered them
// here, so past 200 the list was short and its total counted rows it then hid.
// The engine answers `health=not_ok` itself now, with the predicate the
// connector-health ratio counts against, so this page sends it on and pages
// like any other list.

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

/** A record of a catalogue, as the engine answers it. */
export type RecordValue = Record<string, unknown>;

/** What this record is FOR, as its author wrote it. Never a slug and never an
 *  id: a fallback that prints an identifier answers a different question than
 *  the one the reader asked. */
export function recordPurpose(record: RecordValue | undefined): string | null {
  const value = record?.description;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The record's name, from the first field of its kind that carries one. */
export function recordTitle(record: RecordValue | undefined): string {
  for (const key of ["name", "display_name", "title", "filename", "slug"]) {
    const value = record?.[key];
    if (typeof value === "string" && value) return value;
  }
  return "—";
}
