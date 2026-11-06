import type { components } from "@cli-core/engine-api/openapi";
import type { TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";

export type RefusalReason = NonNullable<
  components["schemas"]["ExecutionOutcome"]["refusal_reason"]
>;

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export const REFUSAL_REASON_KEYS = {
  not_json_raw: "refusal.reason.not_json_raw",
  not_base64url: "refusal.reason.not_base64url",
  not_utf8: "refusal.reason.not_utf8",
  header_control_byte: "refusal.reason.header_control_byte",
  header_folded: "refusal.reason.header_folded",
  header_not_allowed: "refusal.reason.header_not_allowed",
  header_duplicate: "refusal.reason.header_duplicate",
  missing_headers: "refusal.reason.missing_headers",
  sender_invalid: "refusal.reason.sender_invalid",
  recipient_invalid: "refusal.reason.recipient_invalid",
  extra_recipients: "refusal.reason.extra_recipients",
  multipart_unsupported: "refusal.reason.multipart_unsupported",
  content_type_unsupported: "refusal.reason.content_type_unsupported",
  transfer_encoding_unsupported: "refusal.reason.transfer_encoding_unsupported",
  body_not_base64: "refusal.reason.body_not_base64",
  recipient_differs: "refusal.reason.recipient_differs",
  sender_differs: "refusal.reason.sender_differs",
  content_type_differs: "refusal.reason.content_type_differs",
} as const satisfies Record<RefusalReason, TranslationKey>;

export function refusalReasonKey(reason: string): TranslationKey | undefined {
  return Object.hasOwn(REFUSAL_REASON_KEYS, reason)
    ? REFUSAL_REASON_KEYS[reason as RefusalReason]
    : undefined;
}

export function refusalReasonLabel(
  reason: string | null | undefined,
  t: Translate,
): CatalogLabel | null {
  if (!reason) return null;
  return catalogLabel(reason, refusalReasonKey(reason), t);
}
