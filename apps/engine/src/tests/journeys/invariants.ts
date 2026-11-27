import { sql } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { decryptSecret, vaultItemAadCandidates } from "../../crypto/index.ts";
import type { Db } from "../../db/client.ts";
import { vaultItems } from "../../db/schema/index.ts";
import { logRing } from "../../observability/log-ring.ts";
import { waitFor } from "../../test-helpers/determinism/index.ts";

const MIN_SECRET_LENGTH = 8;
const NON_SECRET_FIELDS = new Set(["mode", "username", "issuer", "token_type", "expires_at"]);
const CLOSING_AUDIT_ACTIONS = [
  "execution.completed",
  "execution.aborted",
  "execution.failed",
  "execution.crash_recovered",
];
const SETTLE_TRIES = 40;
const SETTLE_SLEEP_MS = 50;

export interface InvariantInput {
  db: Db;
  knownSecrets: readonly string[];
  logs: () => readonly string[];
  liveWorker: (executionId: string) => boolean;
}

interface Row {
  [key: string]: unknown;
}

async function rows(db: Db, query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(query)).rows as Row[];
}

function leafStrings(value: unknown, key = ""): string[] {
  if (typeof value === "string") return NON_SECRET_FIELDS.has(key) ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((item) => leafStrings(item, key));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([name, item]) => leafStrings(item, name));
  return [];
}

async function vaultSecrets(db: Db): Promise<string[]> {
  const items = await db
    .select({
      id: vaultItems.id,
      tenant_id: vaultItems.tenant_id,
      owner_user_id: vaultItems.owner_user_id,
      kind: vaultItems.kind,
      ciphertext: vaultItems.ciphertext,
      iv: vaultItems.iv,
      auth_tag: vaultItems.auth_tag,
    })
    .from(vaultItems);
  return items.flatMap((item) =>
    vaultItemAadCandidates(item).flatMap((aad) => {
      try {
        const plain = decryptSecret(
          { ciphertext: item.ciphertext, iv: item.iv, auth_tag: item.auth_tag },
          aad,
        );
        return plain.length > 0 ? leafStrings(JSON.parse(plain)) : [];
      } catch {
        return [];
      }
    }),
  );
}

async function runningWithoutWorker(input: InvariantInput): Promise<string[]> {
  const running = await rows(
    input.db,
    sql`SELECT id::text AS id FROM executions WHERE status = 'running' ORDER BY id`,
  );
  return running.map((row) => String(row.id)).filter((id) => !input.liveWorker(id));
}

async function stuckRuns(input: InvariantInput): Promise<string[]> {
  let stuck: string[] = [];
  try {
    await waitFor(
      async () => {
        stuck = await runningWithoutWorker(input);
        return stuck.length === 0;
      },
      { tries: SETTLE_TRIES, sleepMs: SETTLE_SLEEP_MS, label: "runs settle" },
    );
  } catch {
    return stuck.map((id) => `execution ${id} is running without a live worker`);
  }
  return [];
}

async function auditGaps(db: Db): Promise<string[]> {
  await _drainAuditWritesForTests();
  const gaps = await rows(
    db,
    sql`SELECT e.id::text AS id, e.status AS status
        FROM executions e
        WHERE e.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
          AND EXISTS (
            SELECT 1 FROM audit_log s
            WHERE s.resource_id = e.id::text AND s.action = 'execution.started'
          )
          AND NOT EXISTS (
            SELECT 1 FROM audit_log c
            WHERE c.resource_id = e.id::text
              AND c.action IN (${sql.join(
                CLOSING_AUDIT_ACTIONS.map((action) => sql`${action}`),
                sql`, `,
              )})
          )
        ORDER BY e.id`,
  );
  return gaps.map(
    (row) => `execution ${String(row.id)} ended ${String(row.status)} without a closing audit row`,
  );
}

async function leakedSecrets(input: InvariantInput): Promise<string[]> {
  const secrets = [...new Set([...input.knownSecrets, ...(await vaultSecrets(input.db))])].filter(
    (secret) => secret.length >= MIN_SECRET_LENGTH,
  );
  if (secrets.length === 0) return [];
  const stored = await rows(
    input.db,
    sql`SELECT 'execution step ' || id::text AS place,
               concat_ws(' ', output_preview::text, input_preview::text, result_preview,
                         error::text, request_meta::text) AS text
          FROM execution_steps
        UNION ALL
        SELECT 'execution ' || id::text,
               concat_ws(' ', failure::text, result_markdown, sensitive_result::text)
          FROM executions
        UNION ALL
        SELECT 'audit ' || action || ' ' || id::text,
               concat_ws(' ', metadata::text, before::text, after::text, reason)
          FROM audit_log
        UNION ALL
        SELECT 'llm usage ' || id::text, error FROM llm_usage`,
  );
  const places = [
    ...stored.map((row) => ({ place: String(row.place), text: String(row.text ?? "") })),
    ...input.logs().map((text, index) => ({ place: `log line ${index}`, text })),
  ];
  return places.flatMap(({ place, text }) =>
    secrets.some((secret) => text.includes(secret)) ? [`${place} contains a secret value`] : [],
  );
}

async function budgetDrift(db: Db): Promise<string[]> {
  const drift = await rows(
    db,
    sql`SELECT id::text AS id
          FROM llm_usage
         WHERE prompt_tokens < 0 OR completion_tokens < 0 OR cache_read_tokens < 0
            OR cache_creation_tokens < 0 OR total_tokens < 0
            OR (cache_read_tokens = 0 AND cache_creation_tokens = 0
                AND total_tokens <> prompt_tokens + completion_tokens)
         ORDER BY id`,
  );
  return drift.map((row) => `llm usage ${String(row.id)} does not add up`);
}

async function orphanedHolds(input: InvariantInput): Promise<string[]> {
  const held = await rows(
    input.db,
    sql`SELECT s.id::text AS id, e.id::text AS execution_id, e.status AS status,
               e.hold_writes AS hold_writes
          FROM execution_steps s
          JOIN executions e ON e.id = s.execution_id
         WHERE s.held
         ORDER BY s.id`,
  );
  return held.flatMap((row) => {
    const executionId = String(row.execution_id);
    if (row.hold_writes !== true)
      return [`held step ${String(row.id)} belongs to a run that was not asked to hold writes`];
    if (row.status === "running" && !input.liveWorker(executionId))
      return [`held step ${String(row.id)} waits in a run without a live worker`];
    return [];
  });
}

export async function journeyInvariantViolations(input: InvariantInput): Promise<string[]> {
  const stuck = await stuckRuns(input);
  const [audit, secrets, budget, holds] = await Promise.all([
    auditGaps(input.db),
    leakedSecrets(input),
    budgetDrift(input.db),
    orphanedHolds(input),
  ]);
  return [...stuck, ...audit, ...secrets, ...budget, ...holds];
}

export function captureLogLines(): { lines: () => readonly string[]; stop: () => void } {
  const lines: string[] = [];
  const stop = logRing.subscribe((entry) => {
    lines.push(JSON.stringify(entry));
  });
  return { lines: () => lines, stop };
}
