import type { TranslationKey } from "@/lib/i18n";
import type { useI18n } from "@/lib/i18n-context";
import type { AccessType, Source } from "./audit-filter-state";
export const SOURCE_KEYS: Record<Source, TranslationKey> = {
  api: "audit.timeline.source.api",
  cli: "audit.timeline.source.cli",
  scheduler: "audit.timeline.source.scheduler",
  mcp: "audit.timeline.source.mcp",
  webhook: "audit.timeline.source.webhook",
  "tool-chain": "audit.timeline.source.tool-chain",
  ui: "audit.timeline.source.ui",
  chat: "audit.timeline.source.chat",
  queue: "audit.timeline.source.queue",
};
export const ACCESS_KEYS: Record<AccessType, TranslationKey> = {
  api_key: "audit.timeline.accessType.apiKey",
  browser_session: "audit.timeline.accessType.browserSession",
  mcp_oauth: "audit.timeline.accessType.mcpOAuth",
  token_exchange: "audit.timeline.accessType.tokenExchange",
  external_bearer: "audit.timeline.accessType.externalBearer",
  task_run: "audit.timeline.accessType.taskRun",
  portal_token: "audit.timeline.accessType.portalToken",
};
export function sourceLabel(
  source: string | null | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string {
  return source && Object.hasOwn(SOURCE_KEYS, source)
    ? t(SOURCE_KEYS[source as Source])
    : t("audit.timeline.notRecorded");
}
export function accessLabel(
  access: string | null | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string {
  return access && Object.hasOwn(ACCESS_KEYS, access)
    ? t(ACCESS_KEYS[access as AccessType])
    : t("audit.timeline.notRecorded");
}
