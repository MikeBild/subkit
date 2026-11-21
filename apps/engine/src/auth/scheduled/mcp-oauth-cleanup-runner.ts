import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../../audit/index.ts";
import type { Db, Executor } from "../../db/client.ts";
import { errorFields, logger } from "../../logging/index.ts";

const MCP_OAUTH_CLEANUP_BATCH_SIZE = 256;

const returnedKeys = z
  .array(z.object({ id: z.string().uuid() }).strict())
  .max(MCP_OAUTH_CLEANUP_BATCH_SIZE);
const units = [
  "access_tokens_deleted",
  "refresh_tokens_deleted",
  "codes_deleted",
  "clients_deleted",
  "clients_retired",
  "states_deleted",
  "connector_oauth_start_grants_deleted",
  "connector_oauth_states_deleted",
] as const;
type Unit = (typeof units)[number];

const expiredToken = sql`(r.expires_at < now()-interval '7 days' OR r.revoked_at < now()-interval '7 days')`;
const unusedClient = sql`r.created_at < now()-interval '30 days'
  AND NOT EXISTS(SELECT 1 FROM subkit.mcp_oauth_refresh_tokens p WHERE p.client_id=r.client_id)
  AND NOT EXISTS(SELECT 1 FROM subkit.mcp_oauth_access_tokens p WHERE p.client_id=r.client_id)
  AND NOT EXISTS(SELECT 1 FROM subkit.mcp_oauth_authorization_codes p WHERE p.client_id=r.client_id)`;
const deadRegistration = sql`r.registration_source='dcr' AND r.disabled_at IS NULL AND r.created_at < now()-interval '7 days'
  AND NOT EXISTS(SELECT 1 FROM subkit.mcp_oauth_access_tokens p WHERE p.client_id=r.client_id AND ((p.revoked_at IS NULL AND p.expires_at>now()) OR p.last_used_at>now()-interval '7 days'))
  AND NOT EXISTS(SELECT 1 FROM subkit.mcp_oauth_refresh_tokens p WHERE p.client_id=r.client_id AND ((p.revoked_at IS NULL AND p.expires_at>now()) OR p.created_at>now()-interval '7 days'))
  AND NOT EXISTS(SELECT 1 FROM subkit.mcp_oauth_authorization_codes p WHERE p.client_id=r.client_id AND p.created_at>now()-interval '7 days')`;

const definitions: ReadonlyArray<{
  unit: Unit;
  table: string;
  predicate: SQL;
  global?: true;
  retire?: true;
}> = [
  { unit: "access_tokens_deleted", table: "mcp_oauth_access_tokens", predicate: expiredToken },
  { unit: "refresh_tokens_deleted", table: "mcp_oauth_refresh_tokens", predicate: expiredToken },
  {
    unit: "codes_deleted",
    table: "mcp_oauth_authorization_codes",
    predicate: sql`r.expires_at < now()-interval '1 day'`,
  },
  { unit: "clients_deleted", table: "mcp_oauth_clients", predicate: unusedClient, global: true },
  {
    unit: "clients_retired",
    table: "mcp_oauth_clients",
    predicate: deadRegistration,
    global: true,
    retire: true,
  },
  { unit: "states_deleted", table: "mcp_oauth_states", predicate: sql`r.expires_at < now()` },
  {
    unit: "connector_oauth_start_grants_deleted",
    table: "connector_oauth_start_grants",
    predicate: sql`r.expires_at < now()`,
  },
  {
    unit: "connector_oauth_states_deleted",
    table: "connector_oauth_states",
    predicate: sql`r.expires_at < now()`,
  },
];

const refreshKeys = z
  .array(z.object({ id: z.string().uuid(), tenant_id: z.string().uuid() }).strict())
  .max(64);

function keyRelation(keys: z.infer<typeof refreshKeys>): SQL {
  return sql.join(
    keys.map((key) => sql`(${key.id}::uuid,${key.tenant_id}::uuid)`),
    sql`,`,
  );
}

async function pruneClients(tx: Executor, predicate: SQL, retire: boolean): Promise<number> {
  const keys = z
    .array(z.object({ id: z.string().uuid(), client_id: z.string() }).strict())
    .max(MCP_OAUTH_CLEANUP_BATCH_SIZE)
    .parse(
      (
        await tx.execute(sql`WITH candidates AS MATERIALIZED (
    SELECT r.id,r.client_id FROM subkit.mcp_oauth_clients r WHERE ${predicate} ORDER BY r.id LIMIT ${MCP_OAUTH_CLEANUP_BATCH_SIZE} FOR UPDATE OF r SKIP LOCKED
  ) SELECT id,client_id FROM candidates`)
      ).rows,
    );
  if (keys.length === 0) return 0;
  const values = sql.join(
    keys.map((key) => sql`(${key.id}::uuid,${key.client_id}::text)`),
    sql`,`,
  );
  const mutation = retire
    ? sql`UPDATE subkit.mcp_oauth_clients r SET disabled_at=now(),retired_at=now() FROM candidates`
    : sql`DELETE FROM subkit.mcp_oauth_clients r USING candidates`;
  const result =
    await tx.execute(sql`WITH candidates(id,client_id) AS (VALUES ${values}) ${mutation}
    WHERE r.id=candidates.id AND r.client_id=candidates.client_id AND ${predicate} RETURNING r.id`);
  return returnedKeys.parse(result.rows).length;
}

async function pruneRefreshTokens(tx: Executor): Promise<{ deleted: number; detached: number }> {
  let deleted = 0;
  let detached = 0;
  for (let round = 0; round < 2; round++) {
    const parents = refreshKeys.parse(
      (
        await tx.execute(sql`SELECT r.id,r.tenant_id FROM subkit.mcp_oauth_refresh_tokens r
      WHERE ${expiredToken} AND EXISTS(SELECT 1 FROM subkit.mcp_oauth_access_tokens a WHERE a.refresh_token_id=r.id)
      ORDER BY r.id LIMIT 64 FOR UPDATE OF r SKIP LOCKED`)
      ).rows,
    );
    if (parents.length > 0) {
      const result =
        await tx.execute(sql`WITH parents(id,tenant_id) AS (VALUES ${keyRelation(parents)}), candidates AS MATERIALIZED (
        SELECT a.id,a.tenant_id,a.refresh_token_id FROM subkit.mcp_oauth_access_tokens a JOIN parents p ON p.id=a.refresh_token_id
        JOIN subkit.mcp_oauth_refresh_tokens r ON r.id=p.id AND r.tenant_id=p.tenant_id
        WHERE ${expiredToken} ORDER BY a.id LIMIT 64 FOR UPDATE OF a SKIP LOCKED
      ) UPDATE subkit.mcp_oauth_access_tokens a SET refresh_token_id=NULL FROM candidates c
      WHERE a.id=c.id AND a.tenant_id=c.tenant_id AND a.refresh_token_id=c.refresh_token_id
      AND EXISTS(SELECT 1 FROM subkit.mcp_oauth_refresh_tokens r WHERE r.id=c.refresh_token_id AND ${expiredToken}) RETURNING a.id`);
      detached += returnedKeys.parse(result.rows).length;
    }
    const keys = refreshKeys.parse(
      (
        await tx.execute(sql`SELECT r.id,r.tenant_id FROM subkit.mcp_oauth_refresh_tokens r WHERE ${expiredToken}
      AND NOT EXISTS(SELECT 1 FROM subkit.mcp_oauth_access_tokens a WHERE a.refresh_token_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM subkit.mcp_oauth_refresh_tokens p WHERE p.rotated_to_id=r.id)
      ORDER BY r.id LIMIT 64 FOR UPDATE OF r SKIP LOCKED`)
      ).rows,
    );
    if (keys.length > 0) {
      const result =
        await tx.execute(sql`WITH candidates(id,tenant_id) AS (VALUES ${keyRelation(keys)})
        DELETE FROM subkit.mcp_oauth_refresh_tokens r USING candidates c WHERE r.id=c.id AND r.tenant_id=c.tenant_id AND ${expiredToken}
        AND NOT EXISTS(SELECT 1 FROM subkit.mcp_oauth_access_tokens a WHERE a.refresh_token_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM subkit.mcp_oauth_refresh_tokens p WHERE p.rotated_to_id=r.id) RETURNING r.id`);
      deleted += returnedKeys.parse(result.rows).length;
    }
  }
  if (deleted + detached > MCP_OAUTH_CLEANUP_BATCH_SIZE)
    throw new Error("oauth_cleanup_bound_exceeded");
  return { deleted, detached };
}

export async function runMcpOAuthCleanup(started: Date, db: Db): Promise<void> {
  const counts = Object.fromEntries(units.map((unit) => [unit, 0]));
  for (const definition of definitions) {
    try {
      counts[definition.unit] = await db.transaction(async (tx) => {
        let changed: number;
        let detached = 0;
        if (definition.unit === "refresh_tokens_deleted") {
          const result = await pruneRefreshTokens(tx);
          changed = result.deleted;
          detached = result.detached;
        } else if (definition.global) {
          changed = await pruneClients(tx, definition.predicate, definition.retire === true);
        } else {
          const table = sql.identifier(definition.table);
          const identity = sql`r.tenant_id=candidates.tenant_id`;
          const keys = sql`r.id,r.tenant_id`;
          const mutation = sql`DELETE FROM subkit.${table} r USING candidates`;
          const result = await tx.execute(sql`WITH candidates AS MATERIALIZED (
          SELECT ${keys} FROM subkit.${table} r WHERE ${definition.predicate}
          ORDER BY r.id LIMIT ${MCP_OAUTH_CLEANUP_BATCH_SIZE} FOR UPDATE OF r SKIP LOCKED
        ) ${mutation} WHERE r.id=candidates.id AND ${identity} AND ${definition.predicate} RETURNING r.id`);
          changed = returnedKeys.parse(result.rows).length;
        }
        const metadata = {
          request_source: "scheduler",
          sweep: definition.unit,
          access_references_detached: detached,
          ...Object.fromEntries(
            units.map((unit) => [unit, unit === definition.unit ? changed : 0]),
          ),
        };
        if (definition.retire && changed > 0)
          await auditAwait(
            {
              tenant_id: SYSTEM_TENANT_ID,
              actor_type: "system",
              actor_id: null,
              action: AuditAction.MCP_OAUTH_CLIENT_RETIRED,
              resource_type: "mcp_oauth_client",
              resource_id: null,
              result: "success",
              metadata: { request_source: "scheduler", count: changed },
            },
            tx,
          );
        await auditAwait(
          {
            tenant_id: SYSTEM_TENANT_ID,
            actor_type: "system",
            actor_id: null,
            action: AuditAction.MCP_OAUTH_EXPIRED_PRUNED,
            resource_type: "mcp_oauth_token",
            resource_id: null,
            result: "success",
            metadata,
          },
          tx,
        );
        return changed;
      });
    } catch (err) {
      logger.error({
        module: "scheduler",
        action: "mcp_oauth_cleanup.unit_failed",
        msg: "MCP OAuth cleanup unit failed",
        sweep: definition.unit,
        tick_id: started.toISOString(),
        ...errorFields(err),
      });
    }
  }
  logger.info({
    module: "scheduler",
    action: "mcp_oauth_cleanup.fired",
    msg: "MCP OAuth cleanup cron pass completed",
    tick_id: started.toISOString(),
    ...counts,
    duration_ms: Date.now() - started.getTime(),
  });
}
