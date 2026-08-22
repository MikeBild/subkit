// The one rule that decides what an audit row may carry to disk.
//
// Audit rows are append-only and ride the ndjson export, so a secret or a
// prompt that lands in `before` / `after` / `reason` / `metadata` is durable
// forever and leaves the deployment with every compliance extract.
//
// LOCAL-SK-ZWEITER-AUDIT-SCHREIBER — this used to live inline in
// `audit/audit.ts#buildEntry`, which made it a property of ONE writer rather
// than of the table. `EngineClient.audit_write` held its own
// `insert(auditLog)` and reached `audit_log` without it, so ~32 conversation
// write tools wrote `prompt` and `api_token` verbatim. Measured against that
// version: `audit()` leaked 1 of 3 probe payloads, `audit_write()` 3 of 3.
//
// The rule now sits in one function that BOTH the entry builder and the
// single SQL writer (`db/audit.ts#writeAudit`) apply, so a future writer
// reaching `writeAudit` is scrubbed whether or not it knows to ask. A writer
// that skips `writeAudit` altogether is caught by the
// `audit_log has a single writer` invariant in
// `apps/engine/scripts/audit-invariants.ts`.
//
// Applied twice on the `audit()` path (builder, then writer) on purpose: the
// builder's copy is what the structured logger mirrors, so removing it would
// send an unscrubbed payload to the log. The pass is idempotent — every
// marker it writes matches the "already redacted" guard in
// `@shared/redaction.ts` — so the second application is a no-op.

import { scrubSecrets } from "../logging/scrub-secrets.ts";
import type { AuditEntry } from "./types.ts";

export function scrubAuditEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    before: (entry.before === undefined || entry.before === null
      ? null
      : scrubSecrets(entry.before)) as AuditEntry["before"],
    after: (entry.after === undefined || entry.after === null
      ? null
      : scrubSecrets(entry.after)) as AuditEntry["after"],
    reason: typeof entry.reason === "string" ? (scrubSecrets(entry.reason) as string) : null,
    metadata: scrubSecrets(entry.metadata ?? {}) as Record<string, unknown>,
  };
}
