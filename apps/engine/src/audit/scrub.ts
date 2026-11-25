import { scrubSecrets } from "../logging/scrub-secrets.ts";
import { isUuid } from "../utils/index.ts";
import type { AuditEntry } from "./types.ts";

const SNAPSHOT_SCRUB = { promptKeys: false } as const;
const NUL = "\u0000";
const REPLACEMENT = "\uFFFD";

function withoutNul(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll(NUL, REPLACEMENT);
  if (Array.isArray(value)) return value.map(withoutNul);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key.replaceAll(NUL, REPLACEMENT),
        withoutNul(inner),
      ]),
    );
  }
  return value;
}

export function scrubAuditEntry(entry: AuditEntry): AuditEntry {
  const metadata = withoutNul(scrubSecrets(entry.metadata ?? {})) as Record<string, unknown>;
  if (typeof entry.metadata?.api_key_id === "string" && isUuid(entry.metadata.api_key_id)) {
    metadata.api_key_id = entry.metadata.api_key_id;
  }
  if (
    typeof entry.metadata?.audit_used_api_key_id === "string" &&
    isUuid(entry.metadata.audit_used_api_key_id)
  ) {
    metadata.audit_used_api_key_id = entry.metadata.audit_used_api_key_id;
  }
  if (entry.metadata?.audit_credential_origin === "cli_oauth_session") {
    metadata.audit_credential_origin = "cli_oauth_session";
  }
  return {
    ...entry,
    resource_id:
      typeof entry.resource_id === "string" ? (withoutNul(entry.resource_id) as string) : null,
    user_agent:
      typeof entry.user_agent === "string" ? (withoutNul(entry.user_agent) as string) : null,
    before: (entry.before === undefined || entry.before === null
      ? null
      : withoutNul(scrubSecrets(entry.before, SNAPSHOT_SCRUB))) as AuditEntry["before"],
    after: (entry.after === undefined || entry.after === null
      ? null
      : withoutNul(scrubSecrets(entry.after, SNAPSHOT_SCRUB))) as AuditEntry["after"],
    reason:
      typeof entry.reason === "string" ? (withoutNul(scrubSecrets(entry.reason)) as string) : null,
    metadata,
  };
}
