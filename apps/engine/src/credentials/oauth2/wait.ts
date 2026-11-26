import { and, eq, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { type Db, dbOnClient, type Executor, vaultItems, withTenantScope } from "../../db/index.ts";
import { logger } from "../../logging/index.ts";
import { getListener } from "../../pubsub/listener.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import {
  ConnectorOauthCallbackFailedPayloadSchema,
  ConnectorOauthCallbackPayloadSchema,
} from "../../pubsub/types.ts";

export type OAuthWaitStatus = "succeeded" | "failed" | "timeout";

interface WaitForOAuthCredentialInput {
  tenant_id: string;
  connector_id: string;
  environment: "dev" | "prod";
  timeout_ms?: number;
  db: Db;
  listener?: {
    on: <P = unknown>(
      channel: "connector.oauth",
      handler: (event: EventEnvelope<P>) => void,
    ) => void;
    off: <P = unknown>(
      channel: "connector.oauth",
      handler: (event: EventEnvelope<P>) => void,
    ) => void;
  };
}

export const OAUTH_WAIT_CEILING_MS = 45_000;
export const OAUTH_WAIT_MIN_FLOOR_MS = 5_000;
export const POLL_INTERVAL_MS = 1_500;
const OAUTH_CREDENTIAL_READ_TIMEOUT_MS = 1_000;

type BoundedPool = {
  totalCount: number;
  idleCount: number;
  ending?: boolean;
  ended?: boolean;
  connect: () => Promise<pg.PoolClient>;
};

const databasesWithCredentialPollInFlight = new WeakSet<object>();

function poolFor(db: Db): BoundedPool | null {
  const candidate = (db as Db & { $client?: Partial<BoundedPool> }).$client;
  if (
    !candidate ||
    typeof candidate.connect !== "function" ||
    typeof candidate.totalCount !== "number" ||
    typeof candidate.idleCount !== "number"
  ) {
    return null;
  }
  return candidate as BoundedPool;
}

function readCredentialRows(
  db: Executor,
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  readTimeoutMs: number,
): Promise<Array<{ id: string }>> {
  return withTenantScope(db, tenant_id, async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${String(readTimeoutMs)}, true)`);
    return tx
      .select({ id: vaultItems.id })
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.tenant_id, tenant_id),
          eq(vaultItems.connector_id, connector_id),
          eq(vaultItems.environment, environment),
          isNull(vaultItems.deleted_at),
        ),
      )
      .limit(1);
  });
}

async function credentialExistsWithBoundedPool(
  pool: BoundedPool,
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  readTimeoutMs: number,
): Promise<boolean | null> {
  if (pool.ending || pool.ended) return null;

  if (pool.totalCount > 0 && pool.idleCount === 0) return null;

  const client = await pool.connect();
  let released = false;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const timeoutError = new Error("OAuth credential read timed out");
  try {
    const query = readCredentialRows(
      dbOnClient(client),
      tenant_id,
      connector_id,
      environment,
      readTimeoutMs,
    );
    query.catch((err) =>
      logger.debug({
        module: "oauth",
        action: "oauth.wait.read_settled_after_race",
        msg: "credential read failed after the wait already settled",
        tenant_id,
        connector_id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    const timedOut = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(timeoutError), readTimeoutMs);
      deadline.unref?.();
    });
    const rows = await Promise.race([query, timedOut]);
    return rows.length > 0;
  } catch (err) {
    client.release(err instanceof Error ? err : timeoutError);
    released = true;
    throw err;
  } finally {
    if (deadline) clearTimeout(deadline);
    if (!released) client.release();
  }
}

async function credentialExists(
  db: Db,
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  readTimeoutMs: number,
): Promise<boolean | null> {
  const pool = poolFor(db);
  if (pool) {
    return credentialExistsWithBoundedPool(
      pool,
      tenant_id,
      connector_id,
      environment,
      readTimeoutMs,
    );
  }
  const rows = await readCredentialRows(db, tenant_id, connector_id, environment, readTimeoutMs);
  return rows.length > 0;
}

async function credentialExistsSingleFlight(
  db: Db,
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
  readTimeoutMs: number,
): Promise<boolean | null> {
  if (databasesWithCredentialPollInFlight.has(db)) return null;
  databasesWithCredentialPollInFlight.add(db);
  try {
    return await credentialExists(db, tenant_id, connector_id, environment, readTimeoutMs);
  } finally {
    databasesWithCredentialPollInFlight.delete(db);
  }
}

export function waitForOAuthCredential(p: WaitForOAuthCredentialInput): Promise<OAuthWaitStatus> {
  const timeoutMs = p.timeout_ms ?? OAUTH_WAIT_CEILING_MS;
  const readTimeoutMs = Math.max(1, Math.min(OAUTH_CREDENTIAL_READ_TIMEOUT_MS, timeoutMs));

  return new Promise<OAuthWaitStatus>((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let pollInFlight = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let subscribedListener: WaitForOAuthCredentialInput["listener"] | null = null;

    const handler = (event: EventEnvelope): void => {
      if (settled) return;
      if (event.tenant_id !== p.tenant_id) return;
      if (event.type === "connector.oauth.callback_succeeded") {
        const parsed = ConnectorOauthCallbackPayloadSchema.safeParse(event.payload);
        if (!parsed.success) return;
        if (parsed.data.connector_id !== p.connector_id) return;
        void (async () => {
          if (settled) return;
          try {
            if (
              await credentialExistsSingleFlight(
                p.db,
                p.tenant_id,
                p.connector_id,
                p.environment,
                readTimeoutMs,
              )
            ) {
              finish("succeeded");
            }
          } catch {}
        })();
        return;
      }
      if (event.type === "connector.oauth.callback_failed") {
        const parsed = ConnectorOauthCallbackFailedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) return;
        if (parsed.data.connector_id !== p.connector_id) return;
        finish("failed");
      }
    };

    const cleanup = (): void => {
      try {
        subscribedListener?.off("connector.oauth", handler);
      } catch {}
      if (pollTimer) clearTimeout(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      pollTimer = null;
      timeoutTimer = null;
    };

    const finish = (status: OAuthWaitStatus): void => {
      if (settled) return;
      settled = true;
      cleanup();
      logger.info({
        module: "oauth",
        action: "oauth.wait.resolved",
        msg: "waitForOAuthCredential resolved",
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        environment: p.environment,
        status,
      });
      resolve(status);
    };

    try {
      subscribedListener = p.listener ?? getListener();
      subscribedListener.on("connector.oauth", handler);
    } catch (err) {
      logger.warn({
        module: "oauth",
        action: "oauth.wait.listener_unavailable",
        msg: "pubsub listener unavailable — OAuth wait falls back to DB poll only; callback_failed cannot resolve early",
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const pollCredential = async (): Promise<void> => {
      if (settled || pollInFlight) return;
      pollInFlight = true;
      try {
        if (
          await credentialExistsSingleFlight(
            p.db,
            p.tenant_id,
            p.connector_id,
            p.environment,
            readTimeoutMs,
          )
        ) {
          finish("succeeded");
        }
      } catch (err) {
        logger.debug({
          module: "oauth",
          action: "oauth.wait.poll_failed",
          msg: "waitForOAuthCredential poll tick failed; will retry",
          tenant_id: p.tenant_id,
          connector_id: p.connector_id,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        pollInFlight = false;
        if (!settled) {
          pollTimer = setTimeout(() => void pollCredential(), POLL_INTERVAL_MS);
          pollTimer.unref?.();
        }
      }
    };

    timeoutTimer = setTimeout(() => finish("timeout"), timeoutMs);
    timeoutTimer.unref?.();

    void pollCredential();
  });
}
