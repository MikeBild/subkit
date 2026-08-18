import type { components } from "@/api/schema";

// What an inbox item is about, and where to go and deal with it.
//
// The page this replaces was a raw event log wearing the word "inbox": every
// event in the system, no read state, no target, and a "confirm" button that
// deleted rows for the whole tenant. The engine now records, per event, whether
// a person has to act and what the event concerns — as a typed pointer, not a
// URL, because the same rows are read by the CLI, which has no routes.
//
// Turning that pointer into a link is this file's job, and it is the only place
// that knows the cockpit's own route table.

export type InboxItem = components["schemas"]["CliNotificationInboxItem"];

/** Which cockpit surface owns each kind of thing the engine can point at. */
const RESOURCE_ROUTE: Record<string, string> = {
  workflow: "/workflows",
  connector: "/connectors",
  execution: "/runs",
  conversation: "/chat",
  patch_candidate: "/decisions",
  knowledge_source: "/knowledge",
  skill: "/skills",
  file: "/files",
};

/**
 * Where this item leads, or null.
 *
 * Null when the engine named no resource, when this cockpit has no surface for
 * that kind, or when there is no id — a link that leads nowhere is worse than
 * no link, because it costs a click to discover that.
 */
export function inboxHref(item: {
  resource_type?: string | null | undefined;
  resource_id?: string | null | undefined;
}): string | null {
  if (!item.resource_type || !item.resource_id) return null;
  const base = RESOURCE_ROUTE[item.resource_type];
  if (!base) return null;
  // Collections whose detail route is the list itself take the id as a filter
  // rather than a path segment.
  if (base === "/runs" || base === "/decisions") return base;
  return `${base}/${item.resource_id}`;
}

export type InboxFilter = "all" | "unread" | "actionable";

/** Query string for the engine's own filters, so paging stays correct. */
export function inboxQuery(filter: InboxFilter, limit: number, since: number | null): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (since !== null) params.set("since", String(since));
  if (filter === "unread") params.set("unread_only", "true");
  if (filter === "actionable") params.set("actionable_only", "true");
  return params.toString();
}
