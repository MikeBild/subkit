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
import { resolveConnectorOAuthConfig } from "../../connectors/template-binding.ts";
import type { Db } from "../../db/client.ts";
import { connectors, credentials } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { rotateOAuth2Tokens } from "../service.ts";
import type { DecryptedCredential } from "../types.ts";
import { runCognitoRefreshTokenGrant, runRefreshTokenGrant } from "./client.ts";

export const REFRESH_LEAD_MS = 60_000;

interface RefreshOAuthJob {
  tenant_id: string;
  credential_id: string;
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
  // Need the connector config to build an oauth client.
  // tenant-filter:exempt — background refresh sweeps every tenant
  const connRows = await db
    .select()
    .from(connectors)
    .where(eq(connectors.id, credRow.connector_id))
    .limit(1);
  const connector = connRows[0];
  if (!connector) return decrypted;
  const cfg = await resolveConnectorOAuthConfig(db, tenant_id, {
    id: connector.id,
    environment: connector.environment,
    config: (connector.config as Record<string, unknown>) ?? {},
    template_slug: connector.template_slug ?? null,
    template_snapshot: (connector.template_snapshot as Record<string, unknown> | null) ?? null,
  });
  // Tenant-configurable refresh buffer — falls back to REFRESH_LEAD_MS
  // (60s) when the connector's oauth config doesn't specify one. A
  // tenant whose IdP issues 60-second tokens (rare; Atlassian test
  // keys do this) can shrink it via the connector config.
  const bufferMs =
    typeof cfg?.refresh_buffer_ms === "number" && cfg.refresh_buffer_ms > 0
      ? cfg.refresh_buffer_ms
      : REFRESH_LEAD_MS;
  if (expiresMs > 0 && expiresMs - now > bufferMs) {
    return decrypted; // still fresh
  }
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
    // Branch on grant_type. Cognito's `InitiateAuth` (`USER_PASSWORD_AUTH`
    // + `REFRESH_TOKEN_AUTH`) doesn't speak the OAuth2 spec — it has its
    // own JSON shape and lives at `cognito-idp.<region>.amazonaws.com`.
    // Username + region are required to compute SECRET_HASH on app
    // clients with a secret; pulled from connector config.
    let bundle: Awaited<ReturnType<typeof runRefreshTokenGrant>>;
    if (cfg.grant_type === "cognito_user_password") {
      const cogConfig = (connector.config as Record<string, unknown>) ?? {};
      const cogOauth = (cogConfig.oauth as Record<string, unknown> | undefined) ?? {};
      // Accept aws_region from the canonical slot (`config.aws_region`,
      // normalised at initial-mint time) OR the legacy nested fallback
      // (`config.oauth.aws_region`) for connectors saved before the
      // canonicalisation landed.
      const region =
        typeof cogConfig.aws_region === "string"
          ? cogConfig.aws_region
          : typeof cogOauth.aws_region === "string"
            ? cogOauth.aws_region
            : null;
      const username =
        typeof cogConfig.cognito_username === "string" ? cogConfig.cognito_username : "";
      const useAccessToken = cogConfig.cognito_use_access_token === true;
      if (!region) {
        logger.warn({
          module: "oauth2",
          action: "oauth2.refresh_skipped",
          msg: "cognito connector missing config.aws_region; cannot refresh",
          connector_id: connector.id,
        });
        return decrypted;
      }
      if (cfg.client_secret && !username) {
        // SECRET_HASH = HMAC(client_secret, username + client_id). With
        // an empty username, the hash is wrong and Cognito rejects
        // REFRESH_TOKEN_AUTH with NotAuthorizedException — burning the
        // refresh window. Skip with a clear signal so the operator
        // re-issues the credential (which re-populates
        // `cognito_username` via persistCredential).
        logger.warn({
          module: "oauth2",
          action: "oauth2.refresh_skipped",
          msg: "cognito connector with client_secret missing config.cognito_username; cannot compute SECRET_HASH for refresh. Re-issue the credential.",
          connector_id: connector.id,
        });
        return decrypted;
      }
      bundle = await runCognitoRefreshTokenGrant({
        region,
        client_id: cfg.client_id,
        username,
        password: "",
        ...(cfg.client_secret ? { client_secret: cfg.client_secret } : {}),
        use_access_token: useAccessToken,
        refresh_token: decrypted.refresh_token,
      });
    } else {
      bundle = await runRefreshTokenGrant(cfg, decrypted.refresh_token);
    }
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
  // tenant-filter:exempt — background refresh sweeps every tenant
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
