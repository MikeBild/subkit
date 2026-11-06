import type { components } from "@cli-core/engine-api/openapi";
import { type TranslationKey, translate } from "@/lib/i18n";

export type AuditEntry = components["schemas"]["AuditEntry"];

export const ENTRY: AuditEntry = {
  id: "018f4b4a-6d33-7b3a-9c2d-123456789abc",
  ts: "2026-08-10T09:00:00.000Z",
  tenant_id: "018f4b4a-6d33-7b3a-9c2d-123456789abc",
  actor_type: "user",
  actor_id: "018f4b4a-6d33-7b3a-9c2d-aaaaaaaaaaaa",
  api_key_id: null,
  session_id: null,
  recorded_api_key_id: null,
  recorded_session_id: null,
  access_type: null,
  oauth_client_id: null,
  credential_origin: null,
  request_source: null,
  origin_source: null,
  execution_source: null,
  execution_id: null,
  conversation_id: null,
  workflow_id: null,
  changed_fields: [],
  changes: [],
  details: {},
  correlation_id: null,
  action: "settings.changed",
  resource_type: "settings",
  resource_id: null,
  resource_name: null,
  result: "success",
  trace_id: "cli-949cacce25ff4379",
  ip: "203.0.113.42",
  user_agent: "SubKit-CLI (macOS)",
  before: null,
  after: null,
  reason: null,
  reason_redacted: false,
  metadata: {},
};

export const entry = (patch: Partial<AuditEntry>): AuditEntry => ({ ...ENTRY, ...patch });

export const deText = (key: TranslationKey): string => translate("de", key);
