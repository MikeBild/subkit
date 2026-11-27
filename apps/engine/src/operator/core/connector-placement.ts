import type { AttentionClass, AttentionSeverity } from "./attention.ts";

export const RETIREMENT_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

export interface ConnectorPlacementInput {
  readonly reason: string;
  readonly health_error_code: string | null;
  readonly sunset_at: Date | null;
}

export function connectorPlacement(
  row: ConnectorPlacementInput,
  now: Date,
): { class: AttentionClass; severity: AttentionSeverity } {
  if (row.reason !== "needs_update" || row.health_error_code !== "endpoint_deprecated")
    return { class: "failing", severity: "urgent" };
  if (row.sunset_at === null) return { class: "decide", severity: "notice" };
  const remaining = row.sunset_at.getTime() - now.getTime();
  if (remaining <= 0) return { class: "failing", severity: "urgent" };
  return { class: "decide", severity: remaining <= RETIREMENT_WARNING_MS ? "urgent" : "notice" };
}
