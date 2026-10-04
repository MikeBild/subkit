import { scrubSecrets } from "../logging/scrub-secrets.ts";
import type { AuditEntry } from "./types.ts";

const SNAPSHOT_SCRUB = { promptKeys: false } as const;

export function scrubAuditEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    before: (entry.before === undefined || entry.before === null
      ? null
      : scrubSecrets(entry.before, SNAPSHOT_SCRUB)) as AuditEntry["before"],
    after: (entry.after === undefined || entry.after === null
      ? null
      : scrubSecrets(entry.after, SNAPSHOT_SCRUB)) as AuditEntry["after"],
    reason: typeof entry.reason === "string" ? (scrubSecrets(entry.reason) as string) : null,
    metadata: scrubSecrets(entry.metadata ?? {}) as Record<string, unknown>,
  };
}
