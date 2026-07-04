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
import { flagConnectorAuthFailure } from "../../connectors/reauth.ts";
import { getConnector } from "../../connectors/service.ts";
import { resolveConnectorOAuthConfig } from "../../connectors/template-binding.ts";
import type { Db } from "../../db/client.ts";
import { connectors, credentials } from "../../db/schema/index.ts";
import { errorFields, log, logger } from "../../logging/logger.ts";
import { withJobContext } from "../../queue/job-context.ts";
import { rotateOAuth2Tokens } from "../service.ts";
import type { DecryptedCredential } from "../types.ts";
import {
  runClientCredentialsJsonGrant,
  runCognitoRefreshTokenGrant,
  runRefreshTokenGrant,
} from "./client.ts";

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
  // oauth2 access tokens refreshed here are always connector-owned. A
  // null connector_id means the row belongs to an external MCP server
  // whose refresh path lives in the MCP client subsystem — skip.
  const connectorId = credRow.connector_id;
  if (connectorId == null) return decrypted;
  // For grant types that don't issue a refresh_token (client_credentials_json
  // re-mints directly) we skip the early-return; for all others, a missing
  // refresh_token means the credential cannot be refreshed.
  //
  // We need the connector config to determine the grant_type before
  // deciding whether to short-circuit — so we defer this check below.
  const now = Date.now();
  const expiresMs = decrypted.expires_at ? decrypted.expires_at.getTime() : 0;
  // Need the connector config to build an oauth client.
  // tenant-filter:exempt — background refresh sweeps every tenant
  const connRows = await db
    .select()
    .from(connectors)
    .where(eq(connectors.id, connectorId))
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
  if (!cfg) {
    logger.warn({
      module: "oauth2",
      action: "oauth2.refresh_skipped",
      msg: "connector has incomplete oauth2 config; cannot refresh",
      connector_id: connector.id,
    });
    return decrypted;
  }
  // For grant types that issue no refresh_token the re-mint path handles
  // staleness directly. For all other grants a missing refresh_token means
  // we cannot refresh — return the (stale) credential unchanged so the
  // next outgoing request gets a 401 and the connector is flagged.
  const isRemintGrant = cfg.grant_type === "client_credentials_json";
  if (!decrypted.refresh_token && !isRemintGrant) return decrypted;
  // Tenant-configurable refresh buffer — falls back to REFRESH_LEAD_MS
  // (60s) when the connector's oauth config doesn't specify one. A
  // tenant whose IdP issues 60-second tokens (rare; Atlassian test
  // keys do this) can shrink it via the connector config.
  const bufferMs =
    typeof cfg.refresh_buffer_ms === "number" && cfg.refresh_buffer_ms > 0
      ? cfg.refresh_buffer_ms
      : REFRESH_LEAD_MS;
  if (expiresMs > 0 && expiresMs - now > bufferMs) {
    return decrypted; // still fresh
  }
  // A connector already flagged needs_reauth has a credential believed dead:
  // a prior auth failure (here or at a request site) set the flag, and only a
  // re-issue (`request_connector_reauth`) clears it. Re-attempting the IdP
  // refresh now burns a doomed call PER request step — within one run of an
  // N-item workflow that is N identical refresh attempts against the IdP even
  // though the first failure already flagged the connector. Prod saw exactly
  // this: a single run fired 7 identical list steps → 7 dead Cognito
  // refreshes (7× `oauth2.refresh_error` at error) + 7×401, all after the
  // connector was already needs_reauth. Skip the IdP call: return the stale
  // credential so the request still gets its 401 (the connector is already
  // flagged, so the request-site handler dedups — no re-flag, no re-notify),
  // and record the skip once at debug. A later run, after the user re-issues
  // the credential, sees needs_reauth cleared and refreshes normally.
  if (connector.needs_reauth === true) {
    logger.debug({
      module: "oauth2",
      action: "oauth2.refresh_skipped_needs_reauth",
      msg: "connector already flagged needs_reauth; skipping doomed inline refresh until the credential is re-issued",
      credential_id: credRow.id,
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
    if (cfg.grant_type === "client_credentials_json") {
      // Re-mint by re-posting the stored credential fields to the token
      // endpoint. No refresh token is used — client_id + client_secret
      // live in the connector's config.oauth block.
      const bodyMapping = cfg.token_request_body_mapping;
      const tokenEndpoint = cfg.token_endpoint;
      if (!bodyMapping || Object.keys(bodyMapping).length === 0 || !tokenEndpoint) {
        logger.warn({
          module: "oauth2",
          action: "oauth2.refresh_skipped",
          msg: "client_credentials_json connector missing token_endpoint or token_request_body_mapping; cannot re-mint",
          connector_id: connector.id,
        });
        return decrypted;
      }
      bundle = await runClientCredentialsJsonGrant({
        token_endpoint: tokenEndpoint,
        body_mapping: bodyMapping,
        response_format: cfg.token_response_format ?? "raw",
        token_response_ttl_ms: cfg.token_response_ttl_ms ?? 86_400_000,
        extra_token_headers: cfg.extra_token_headers,
      });
    } else if (cfg.grant_type === "cognito_user_password") {
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
        // refresh_token is guaranteed non-null here: cognito_user_password
        // always issues a RefreshToken at initial mint; the !refresh_token
        // guard above would have returned for any other grant type without
        // a token.
        refresh_token: decrypted.refresh_token ?? "",
      });
    } else {
      // Standard refresh_token grant. The !refresh_token && !isRemintGrant
      // guard above ensures refresh_token is non-null when we reach here.
      bundle = await runRefreshTokenGrant(cfg, decrypted.refresh_token ?? "");
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
      ...errorFields(err),
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
    // A rejected refresh token means the credential is dead — the stale token
    // we return below guarantees the next request gets a 401. Flag the
    // connector at the source so it is marked *before* the doomed request; the
    // shared helper emits the operator notification once on the false→true edge
    // (the dedup guard ensures the later request-site 401 won't double-emit).
    const connector = await getConnector(tenant_id, connectorId, db);
    if (connector) {
      await flagConnectorAuthFailure(db, connector, {
        reason: "oauth2 refresh token rejected by the IdP",
      });
    }
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
        // Bridge the enqueuing tenant across the queue boundary so the
        // refresh's downstream logs inherit the originating context.
        await withJobContext(job.data, async () => {
          const started = Date.now();
          try {
            await handleRefreshJob(opts.db, job.data);
            log.queue.job.completed({
              msg: "connector.refresh-oauth job completed",
              queue: "connector.refresh-oauth",
              job_id: job.id,
              tenant_id: job.data.tenant_id,
              credential_id: job.data.credential_id,
              duration_ms: Date.now() - started,
            });
          } catch (err) {
            log.queue.job.failed({
              msg: "connector.refresh-oauth job failed",
              queue: "connector.refresh-oauth",
              job_id: job.id,
              tenant_id: job.data.tenant_id,
              credential_id: job.data.credential_id,
              ...errorFields(err),
              duration_ms: Date.now() - started,
            });
            throw err;
          }
        });
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
  // This refresh job only services connector-owned oauth2 credentials.
  // MCP-server credentials carry a null connector_id and are
  // refreshed elsewhere.
  if (row.connector_id == null) return;
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
