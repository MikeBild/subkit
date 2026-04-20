// OAuth2 refresh handling.
//
// Two callable surfaces:
//
//   * `refreshIfStale(db, tenant, row, credential)` — synchronous path
//     used from inside the HTTP driver right before a request goes
//     out. If the access token is within REFRESH_LEAD_MS of expiry, we
//     refresh inline (so the outgoing request definitely has a fresh
//     token) AND enqueue a background job for observability. The
//     inline refresh is the real one; the queue job is a no-op if the
//     token is already fresh.
//
//   * `registerOAuth2RefreshHandler(boss, db)` — pg-boss worker for
//     the `connector.refresh-oauth` queue. Other components (e.g. a
//     scheduled reaper) can enqueue jobs to proactively rotate tokens
//     without waiting for a request.
//
// The synchronous inline path is chosen because round-tripping through
// pg-boss takes longer than the refresh itself in the common case,
// which would just push the stale token out to the upstream anyway.

import { eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { connectors, credentials } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { rotateOAuth2Tokens } from "../service.ts";
import type { DecryptedCredential } from "../types.ts";
import { runRefreshTokenGrant } from "./client.ts";
import type { OAuth2ClientConfig } from "./types.ts";

export const REFRESH_LEAD_MS = 60_000;

interface RefreshOAuthJob {
  tenant_id: string;
  credential_id: string;
}

function clientCfgFromConnector(cfg: Record<string, unknown>): OAuth2ClientConfig | null {
  if (!cfg.issuer_url || !cfg.client_id) return null;
  return {
    issuer_url: String(cfg.issuer_url),
    client_id: String(cfg.client_id),
    client_secret: cfg.client_secret ? String(cfg.client_secret) : undefined,
    scope: cfg.scope ? String(cfg.scope) : undefined,
    redirect_uri: cfg.redirect_uri ? String(cfg.redirect_uri) : undefined,
    audience: cfg.audience ? String(cfg.audience) : undefined,
  };
}

/**
 * Refresh a stale oauth2 access token inline. If the token is still
 * fresh (or has no refresh token), the helper returns the passed-in
 * credential unchanged.
 */
export async function refreshIfStale(
  db: Db,
  tenant_id: string,
  credRow: typeof credentials.$inferSelect,
  decrypted: DecryptedCredential & { mode: "oauth2" },
): Promise<DecryptedCredential> {
  if (!decrypted.refresh_token) return decrypted;
  const now = Date.now();
  const expiresMs = decrypted.expires_at ? decrypted.expires_at.getTime() : 0;
  if (expiresMs > 0 && expiresMs - now > REFRESH_LEAD_MS) {
    return decrypted; // still fresh
  }
  // Need the connector config to build an oauth client.
  const connRows = await db
    .select()
    .from(connectors)
    .where(eq(connectors.id, credRow.connector_id))
    .limit(1);
  const connector = connRows[0];
  if (!connector) return decrypted;
  const cfg = clientCfgFromConnector((connector.config as Record<string, unknown>) ?? {});
  if (!cfg) {
    logger.warn({
      module: "oauth2",
      action: "oauth2.refresh_skipped",
      msg: "connector has incomplete oauth2 config; cannot refresh",
      connector_id: connector.id,
    });
    return decrypted;
  }
  try {
    const bundle = await runRefreshTokenGrant(cfg, decrypted.refresh_token);
    await rotateOAuth2Tokens(
      {
        tenant_id,
        credential_id: credRow.id,
        access_token: bundle.access_token,
        token_type: bundle.token_type,
        scope: bundle.scope ?? undefined,
        refresh_token: bundle.refresh_token ?? decrypted.refresh_token,
        expires_at: bundle.expires_at,
        actor_id: null,
      },
      db,
    );
    logger.info({
      module: "oauth2",
      action: "oauth2.refresh_success",
      credential_id: credRow.id,
      connector_id: credRow.connector_id,
    });
    audit(
      {
        tenant_id,
        actor_type: "system",
        action: AuditAction.CREDENTIAL_OAUTH2_REFRESHED,
        resource_type: "credential",
        resource_id: credRow.id,
        result: "success",
        metadata: { connector_id: credRow.connector_id },
      },
      db,
    );
    return {
      mode: "oauth2",
      access_token: bundle.access_token,
      token_type: bundle.token_type,
      scope: bundle.scope ?? undefined,
      refresh_token: bundle.refresh_token ?? decrypted.refresh_token,
      expires_at: bundle.expires_at,
    };
  } catch (err) {
    logger.error({
      module: "oauth2",
      action: "oauth2.refresh_error",
      msg: "failed to refresh oauth2 access token inline",
      credential_id: credRow.id,
      connector_id: credRow.connector_id,
      error: err instanceof Error ? err.message : String(err),
    });
    audit(
      {
        tenant_id,
        actor_type: "system",
        action: AuditAction.CREDENTIAL_OAUTH2_REFRESHED,
        resource_type: "credential",
        resource_id: credRow.id,
        result: "error",
        reason: err instanceof Error ? err.message : String(err),
        metadata: { connector_id: credRow.connector_id },
      },
      db,
    );
    return decrypted;
  }
}

export async function registerOAuth2RefreshHandler(opts: {
  boss: PgBoss;
  db: Db;
}): Promise<string> {
  const workerId = await opts.boss.work<RefreshOAuthJob>(
    "connector.refresh-oauth",
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async (jobs: Job<RefreshOAuthJob>[]) => {
      for (const job of jobs) {
        await handleRefreshJob(opts.db, job.data);
      }
    },
  );
  logger.info({
    module: "queue",
    action: "worker.registered",
    msg: "connector.refresh-oauth worker registered",
    worker_id: workerId,
  });
  return workerId;
}

async function handleRefreshJob(db: Db, data: RefreshOAuthJob): Promise<void> {
  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, data.credential_id))
    .limit(1);
  const row = rows[0];
  if (!row) return;
  if (!row.oauth2_refresh_ciphertext) return;
  // Decrypt via the service to keep AAD logic in one place. Lazy import
  // to avoid a cycle with the HTTP driver.
  const { getCredentialForConnector } = await import("../service.ts");
  const fetched = await getCredentialForConnector(
    data.tenant_id,
    row.connector_id,
    row.environment as "dev" | "prod",
    db,
  );
  if (!fetched || fetched.value.mode !== "oauth2") return;
  await refreshIfStale(db, data.tenant_id, fetched.row, fetched.value);
}
