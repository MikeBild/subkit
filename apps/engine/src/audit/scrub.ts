// The one rule that decides what an audit row may carry to disk.
//
// Audit rows are append-only and ride the ndjson export, so a secret that
// lands in `before` / `after` / `reason` / `metadata` is durable forever and
// leaves the deployment with every compliance extract. Prompt-shaped PROSE
// is held to a narrower rule than a secret — see the block above
// `scrubAuditEntry`, which is the authoritative statement of which net runs
// on which field.
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

// LOCAL-SK-SAEUBERER-FRISST-HISTORIE — the row has TWO kinds of payload
// and they do not get the same net.
//
//   `metadata` / `reason` are FREE-FORM and caller-minted. An assembled
//   prompt, a message array, a tenant snapshot block lands here and
//   exists nowhere else, so the prompt-prose net earns its false
//   positives. This is where the conversation `update_skill` tool writes
//   its `before`/`after` skill snapshots (under `metadata`), which is the
//   leak LOCAL-SK-ZWEITER-AUDIT-SCHREIBER closed. Unchanged.
//
//   `before` / `after` are STRUCTURED SNAPSHOT columns. Every writer puts
//   a row shape there — a Skill row, a connector row + config, a role, a
//   config value, a schema shape — and the row it copies is already
//   stored unredacted in its own table. Worse, this channel is not only a
//   log: `skills/service.ts#updateSkill` writes the snapshot that
//   `restoreSkill` reads back, so the trail doubles as skill version
//   history. Running the prompt-prose net here collapsed `Skill.body` to
//   `***REDACTED:prompt***`, and because `restoreSkill` delegates to
//   `updateSkill`, a restore wrote that marker back as the LIVE body of
//   an append-only record. Data loss, not cosmetics.
//
// So the prompt-prose net is off for `before`/`after` and on everywhere
// else. Both CREDENTIAL nets stay on for all four fields: a
// credential-named key still collapses, and every value-shape pattern
// (PAT, JWT, Bearer, AWS key, presign URL, generic high-entropy run)
// still runs over every string leaf of the snapshot. See
// `ScrubOptions.promptKeys` in `@shared/redaction.ts` for the residual
// this accepts and why the trail is not the exposure.

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
