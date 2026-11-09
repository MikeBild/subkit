export const REPORT_MESSAGE_REFUSALS = [
  "not_json_raw",
  "not_base64url",
  "not_utf8",
  "header_control_byte",
  "header_folded",
  "header_not_allowed",
  "header_duplicate",
  "missing_headers",
  "sender_invalid",
  "recipient_invalid",
  "extra_recipients",
  "multipart_unsupported",
  "content_type_unsupported",
  "transfer_encoding_unsupported",
  "body_not_base64",
] as const;
export type ReportMessageRefusal = (typeof REPORT_MESSAGE_REFUSALS)[number];

export const REPORT_DELIVERY_DISCREPANCIES = [
  "recipient_differs",
  "sender_differs",
  "content_type_differs",
] as const;
export type ReportDeliveryDiscrepancy = (typeof REPORT_DELIVERY_DISCREPANCIES)[number];

export const REPORT_DELIVERY_REFUSALS = [
  ...REPORT_MESSAGE_REFUSALS,
  ...REPORT_DELIVERY_DISCREPANCIES,
] as const;
export type ReportDeliveryRefusal = (typeof REPORT_DELIVERY_REFUSALS)[number];

const KNOWN_REFUSALS: ReadonlySet<string> = new Set(REPORT_DELIVERY_REFUSALS);

export function reportRefusalReason(error: unknown): ReportDeliveryRefusal | null {
  const record = error as { code?: unknown; reason?: unknown } | null;
  if (record?.code !== "execution_authority_changed") return null;
  return typeof record.reason === "string" && KNOWN_REFUSALS.has(record.reason)
    ? (record.reason as ReportDeliveryRefusal)
    : null;
}

const MESSAGE_REFUSALS: ReadonlySet<string> = new Set(REPORT_MESSAGE_REFUSALS);

export function isReportMessageRefusal(reason: unknown): reason is ReportMessageRefusal {
  return typeof reason === "string" && MESSAGE_REFUSALS.has(reason);
}
