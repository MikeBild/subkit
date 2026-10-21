import { scrubSecrets } from "../logging/scrub-secrets.ts";
import type { AuditEntry } from "./types.ts";

const SNAPSHOT_SCRUB = { promptKeys: false } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function scrubAuditEntry(entry: AuditEntry): AuditEntry {
  const metadata = scrubSecrets(entry.metadata ?? {}) as Record<string, unknown>;
  if (typeof entry.metadata?.api_key_id === "string" && UUID_RE.test(entry.metadata.api_key_id)) {
    metadata.api_key_id = entry.metadata.api_key_id;
  }
  if (
    typeof entry.metadata?.audit_used_api_key_id === "string" &&
    UUID_RE.test(entry.metadata.audit_used_api_key_id)
  ) {
    metadata.audit_used_api_key_id = entry.metadata.audit_used_api_key_id;
  }
  if (entry.metadata?.audit_credential_origin === "cli_oauth_session") {
    metadata.audit_credential_origin = "cli_oauth_session";
  }
  return {
    ...entry,
    before: (entry.before === undefined || entry.before === null
      ? null
      : scrubSecrets(entry.before, SNAPSHOT_SCRUB)) as AuditEntry["before"],
    after: (entry.after === undefined || entry.after === null
      ? null
      : scrubSecrets(entry.after, SNAPSHOT_SCRUB)) as AuditEntry["after"],
    reason: typeof entry.reason === "string" ? (scrubSecrets(entry.reason) as string) : null,
    metadata,
  };
}
