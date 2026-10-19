import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  decryptSecretBytesWithKey,
  encryptSecretBytesWithKey,
  parseMasterKeyHex,
  secureEqual,
} from "../crypto/aes-gcm.ts";
import type { Db } from "../db/client.ts";
import { secretAad } from "./environment.ts";
import { type RewrapAcknowledgement, rewrapEvidenceDigest } from "./rewrap-evidence.ts";

const epochSchema = z
  .union([z.number(), z.string().regex(/^[0-9]+$/)])
  .transform((value) => Number(value))
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const statusSchema = z
  .object({ key_epoch: epochSchema, key_digest: digestSchema.nullable() })
  .strict();
const envelopeSchema = z
  .string()
  .max(134217730)
  .regex(/^\\x[0-9a-f]*$/)
  .refine((value) => value.length % 2 === 0);
const rowSchema = z
  .object({
    name: z.string().min(1).max(255),
    version: z.number().int().positive(),
    tenant_id: z.uuid().nullable(),
    ciphertext: envelopeSchema,
    iv: envelopeSchema.refine((value) => value.length === 26),
    auth_tag: envelopeSchema.refine((value) => value.length === 34),
    metadata_sha256: digestSchema,
  })
  .strict();
const pageSchema = z
  .object({
    operation_id: z.uuid(),
    page_number: z.number().int().positive(),
    source_epoch: epochSchema,
    page_sha256: digestSchema,
    has_more: z.boolean(),
    rows: z.array(rowSchema).max(128),
  })
  .strict();
const appliedSchema = z
  .object({
    applied_count: z.number().int().min(0).max(128),
    unchanged_count: z.number().int().min(0).max(128),
    result_epoch: epochSchema,
    audit_id: z.uuid().nullable(),
  })
  .strict();
const digest = (key: Uint8Array) => createHash("sha256").update(key).digest("hex");
const bytes = (value: string) => Buffer.from(value.slice(2), "hex");

const safeCodes = new Set([
  "vault_maintenance_capability_unavailable",
  "vault_maintenance_producers_unresolved",
  "vault_maintenance_request_invalid",
  "vault_maintenance_cursor_invalid",
  "vault_maintenance_page_invalid",
  "vault_maintenance_page_too_large",
  "vault_maintenance_envelope_invalid",
  "vault_maintenance_cas_conflict",
  "vault_maintenance_incomplete",
  "vault_non_registry_stock_unsupported",
  "vault_key_marker_forbidden",
  "rewrap_key_pin_mismatch",
  "rewrap_snapshot_invalid",
  "rewrap_unreadable_version",
  "rewrap_plaintext_mismatch",
  "rewrap_apply_result_invalid",
]);

function safeFailure(error: unknown): Error {
  const visited = new Set<unknown>();
  while (error instanceof Error && !visited.has(error)) {
    visited.add(error);
    if (safeCodes.has(error.message)) return new Error(error.message);
    error = error.cause;
  }
  return new Error("rewrap_maintenance_failed");
}

export async function rewrapRegistryWithMaintenance(
  db: Db,
  previousKeyHex: string,
  acknowledgement: RewrapAcknowledgement,
): Promise<{ names: number; versions: number }> {
  const evidence = rewrapEvidenceDigest(acknowledgement);
  const previousKey = parseMasterKeyHex(previousKeyHex);
  const runningKey = parseMasterKeyHex(process.env.MASTER_KEY ?? "");
  if (secureEqual(previousKey, runningKey)) throw new Error("rewrap_keys_identical");
  const targetDigest = digest(runningKey);
  try {
    const status = statusSchema.parse(
      (await db.execute(sql`SELECT * FROM subkit.vault_maintenance_status()`)).rows[0],
    );
    if (
      status.key_digest !== null &&
      ![targetDigest, digest(previousKey)].includes(status.key_digest)
    ) {
      throw new Error("rewrap_key_pin_mismatch");
    }
    return await db.transaction(async (tx) => {
      try {
        const operation = randomUUID();
        let cursor: { name: string; version: number } | null = null;
        let pageNumber = 1;
        let names = 0;
        let versions = 0;
        let lastChangedName: string | null = null;
        for (;;) {
          const response = await tx.execute(sql`
            WITH page AS MATERIALIZED (
              SELECT subkit.vault_maintenance_snapshot(${operation}::uuid,${status.key_epoch}::bigint,${targetDigest}::text,${evidence}::text,${cursor?.name ?? null}::text,${cursor?.version ?? null}::integer,128) AS value
            ) SELECT to_jsonb(value) AS page FROM page
          `);
          const page = pageSchema.parse(response.rows[0]?.page);
          if (
            page.operation_id !== operation ||
            page.page_number !== pageNumber ||
            page.source_epoch !== status.key_epoch ||
            (page.has_more && page.rows.length === 0)
          )
            throw new Error("rewrap_snapshot_invalid");
          let replaced = 0;
          const replacements = page.rows.map((row) => {
            const payload = {
              ciphertext: bytes(row.ciphertext),
              iv: bytes(row.iv),
              auth_tag: bytes(row.auth_tag),
            };
            const aad = secretAad(row.name, row.version);
            let plaintext: Uint8Array | null = null;
            try {
              decryptSecretBytesWithKey(runningKey, payload, aad);
            } catch {
              try {
                plaintext = decryptSecretBytesWithKey(previousKey, payload, aad);
              } catch {
                throw new Error("rewrap_unreadable_version");
              }
            }
            let next: ReturnType<typeof encryptSecretBytesWithKey> | null = null;
            if (plaintext !== null) {
              next = encryptSecretBytesWithKey(runningKey, plaintext, aad);
              if (!secureEqual(plaintext, decryptSecretBytesWithKey(runningKey, next, aad)))
                throw new Error("rewrap_plaintext_mismatch");
              replaced++;
              versions++;
              if (lastChangedName !== row.name) names++;
              lastChangedName = row.name;
            }
            return sql`ROW(${row.name}::text,${row.version}::integer,${payload.ciphertext}::bytea,${payload.iv}::bytea,${payload.auth_tag}::bytea,${next ? Buffer.from(next.ciphertext) : null}::bytea,${next ? Buffer.from(next.iv) : null}::bytea,${next ? Buffer.from(next.auth_tag) : null}::bytea,${next === null}::boolean)::subkit.vault_cipher_replacement`;
          });
          const applied = appliedSchema.parse(
            (
              await tx.execute(
                sql`SELECT * FROM subkit.vault_maintenance_apply(${operation}::uuid,${page.page_sha256}::text,ARRAY[${sql.join(replacements, sql`, `)}]::subkit.vault_cipher_replacement[],${!page.has_more}::boolean)`,
              )
            ).rows[0],
          );
          if (
            applied.applied_count !== replaced ||
            applied.unchanged_count !== page.rows.length - replaced ||
            applied.result_epoch !== status.key_epoch + (status.key_digest === targetDigest ? 0 : 1)
          )
            throw new Error("rewrap_apply_result_invalid");
          if (!page.has_more) return { names, versions };
          const last = page.rows.at(-1);
          if (!last) throw new Error("rewrap_snapshot_invalid");
          cursor = { name: last.name, version: last.version };
          pageNumber++;
        }
      } catch (error) {
        throw safeFailure(error);
      }
    });
  } catch (error) {
    throw safeFailure(error);
  }
}
