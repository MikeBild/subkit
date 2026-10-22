import type { ToolResult } from "./index.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MEANS_ALL = new Set(["", "*", NIL_UUID]);

export type LookupId = { kind: "omitted" } | { kind: "uuid"; id: string } | { kind: "invalid" };

export function normalizeLookupId(id: string | undefined): LookupId {
  if (id === undefined) return { kind: "omitted" };
  const trimmed = id.trim();
  if (MEANS_ALL.has(trimmed)) return { kind: "omitted" };
  return UUID_RE.test(trimmed) ? { kind: "uuid", id: trimmed } : { kind: "invalid" };
}

export function normalizeLookupCategory(category: string | undefined): string | undefined {
  const trimmed = category?.trim();
  return trimmed ? trimmed : undefined;
}

export function invalidLookupId(resource: "connector" | "workflow", tool: string): ToolResult {
  return {
    ok: false,
    error_code: "invalid_id",
    message: `id must be a ${resource} uuid; omit it to search by query`,
    next_best_actions: [tool],
  };
}
