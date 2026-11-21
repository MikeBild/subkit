import { and, eq, isNull } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { flagConnectorAuthFailure } from "../../connectors/reauth.ts";
import { getConnector } from "../../connectors/service.ts";
import { resolveConnectorOAuthConfig } from "../../connectors/template-binding.ts";
import type { Db } from "../../db/client.ts";
import { connectors, vaultItems } from "../../db/schema/index.ts";
import { withTenantWork } from "../../execution/index.ts";
import { lockActiveTenant, SelfServiceIdentityError } from "../../identity/index.ts";
import { errorFields, log, logger } from "../../logging/index.ts";
import { withActiveTenantJobContext } from "../../queue/job-context.ts";
import { rotateOAuth2Tokens } from "../service.ts";
import type { DecryptedCredential } from "../types.ts";
import {
  runClientCredentialsJsonGrant,
  runCognitoRefreshTokenGrant,
  runRefreshTokenGrant,
} from "./client.ts";

export const REFRESH_LEAD_MS = 60_000;

export interface RefreshOAuthJob {
  tenant_id: string;
  credential_id: string;
}

export async function refreshIfStale(
  db: Db,
  tenant_id: string,
  credRow: typeof vaultItems.$inferSelect,
  decrypted: DecryptedCredential & { mode: "oauth2" },
): Promise<DecryptedCredential> {
  return withTenantWork(tenant_id, async () => {
    if (credRow.tenant_id !== tenant_id) throw new Error("credential_tenant_mismatch");
    const connectorId = credRow.connector_id;
    if (connectorId == null) return decrypted;
    const now = Date.now();
    const expiresMs = decrypted.expires_at ? decrypted.expires_at.getTime() : 0;
    const prepared = await db.transaction(async (tx) => {
      await lockActiveTenant(tenant_id, tx);
      const [current] = await tx
        .select({ generation: vaultItems.credential_generation })
        .from(vaultItems)
        .where(
          and(
            eq(vaultItems.id, credRow.id),
            eq(vaultItems.tenant_id, tenant_id),
            isNull(vaultItems.deleted_at),
          ),
        )
        .limit(1);
      if (!current || current.generation !== credRow.credential_generation)
        throw Object.assign(new Error("credential changed during refresh"), {
          code: "credential_generation_changed",
        });
      const [connector] = await tx
        .select()
        .from(connectors)
        .where(
          and(
            eq(connectors.id, connectorId),
            eq(connectors.tenant_id, tenant_id),
            isNull(connectors.deleted_at),
          ),
        )
        .limit(1);
      if (!connector) return null;
      const cfg = await resolveConnectorOAuthConfig(tx, tenant_id, {
        id: connector.id,
        environment: connector.environment,
        config: (connector.config as Record<string, unknown>) ?? {},
        template_slug: connector.template_slug ?? null,
        template_snapshot: (connector.template_snapshot as Record<string, unknown> | null) ?? null,
      });
      return { connector, cfg };
    });
    if (!prepared) return decrypted;
    const { connector, cfg } = prepared;
    if (!cfg) {
      logger.warn({
        module: "oauth2",
        action: "oauth2.refresh_skipped",
        msg: "connector has incomplete oauth2 config; cannot refresh",
        connector_id: connector.id,
      });
      return decrypted;
    }
    const isRemintGrant = cfg.grant_type === "client_credentials_json";
    if (!decrypted.refresh_token && !isRemintGrant) return decrypted;
    const bufferMs =
      typeof cfg.refresh_buffer_ms === "number" && cfg.refresh_buffer_ms > 0
        ? cfg.refresh_buffer_ms
        : REFRESH_LEAD_MS;
    if (expiresMs > 0 && expiresMs - now > bufferMs) {
      return decrypted;
    }
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
      let bundle: Awaited<ReturnType<typeof runRefreshTokenGrant>>;
      if (cfg.grant_type === "client_credentials_json") {
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
        bundle = await runClientCredentialsJsonGrant(
          {
            token_endpoint: tokenEndpoint,
            body_mapping: bodyMapping,
            response_format: cfg.token_response_format ?? "raw",
            token_response_ttl_ms: cfg.token_response_ttl_ms ?? 86_400_000,
            extra_token_headers: cfg.extra_token_headers,
          },
          { tenant_id, exec: db },
        );
      } else if (cfg.grant_type === "cognito_user_password") {
        const cogConfig = (connector.config as Record<string, unknown>) ?? {};
        const cogOauth = (cogConfig.oauth as Record<string, unknown> | undefined) ?? {};
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
          logger.warn({
            module: "oauth2",
            action: "oauth2.refresh_skipped",
            msg: "cognito connector with client_secret missing config.cognito_username; cannot compute SECRET_HASH for refresh. Re-issue the credential.",
            connector_id: connector.id,
          });
          return decrypted;
        }
        bundle = await runCognitoRefreshTokenGrant(
          {
            region,
            client_id: cfg.client_id,
            username,
            password: "",
            ...(cfg.client_secret ? { client_secret: cfg.client_secret } : {}),
            use_access_token: useAccessToken,
            refresh_token: decrypted.refresh_token ?? "",
          },
          { tenant_id, exec: db },
        );
      } else {
        bundle = await runRefreshTokenGrant(cfg, decrypted.refresh_token ?? "", {
          tenant_id,
          exec: db,
        });
      }
      const rotated = await db.transaction(async (tx) => {
        await lockActiveTenant(tenant_id, tx);
        const rotated = await rotateOAuth2Tokens(
          {
            tenant_id,
            credential_id: credRow.id,
            expected_generation: credRow.credential_generation,
            access_token: bundle.access_token,
            verified_identity: bundle.verified_identity ?? null,
            token_type: bundle.token_type,
            scope: bundle.scope ?? undefined,
            refresh_token: bundle.refresh_token ?? decrypted.refresh_token,
            expires_at: bundle.expires_at,
            actor_id: null,
          },
          tx,
        );
        await auditAwait(
          {
            tenant_id,
            actor_type: "system",
            action: AuditAction.VAULT_ITEM_REFRESHED,
            resource_type: "vault_item",
            resource_id: credRow.id,
            result: "success",
            metadata: { connector_id: credRow.connector_id },
          },
          tx,
        );
        return rotated;
      });
      if (rotated.credential_generation !== null)
        credRow.credential_generation = rotated.credential_generation;
      credRow.verified_identity = rotated.verified_identity;
      logger.info({
        module: "oauth2",
        action: "oauth2.refresh_success",
        credential_id: credRow.id,
        connector_id: credRow.connector_id,
      });
      return {
        mode: "oauth2",
        access_token: bundle.access_token,
        token_type: bundle.token_type,
        scope: bundle.scope ?? undefined,
        refresh_token: bundle.refresh_token ?? decrypted.refresh_token,
        expires_at: bundle.expires_at,
      };
    } catch (err) {
      if (
        err instanceof SelfServiceIdentityError ||
        (err as { code?: string }).code === "credential_generation_changed"
      )
        throw err;
      logger.error({
        module: "oauth2",
        action: "oauth2.refresh_error",
        msg: "failed to refresh oauth2 access token inline",
        credential_id: credRow.id,
        connector_id: credRow.connector_id,
        ...errorFields(err),
      });
      await db.transaction(async (tx) => {
        await lockActiveTenant(tenant_id, tx);
        const [current] = await tx
          .select({ generation: vaultItems.credential_generation })
          .from(vaultItems)
          .where(
            and(
              eq(vaultItems.id, credRow.id),
              eq(vaultItems.tenant_id, tenant_id),
              isNull(vaultItems.deleted_at),
            ),
          )
          .for("update")
          .limit(1);
        if (!current || current.generation !== credRow.credential_generation) return;
        await auditAwait(
          {
            tenant_id,
            actor_type: "system",
            action: AuditAction.VAULT_ITEM_REFRESHED,
            resource_type: "vault_item",
            resource_id: credRow.id,
            result: "error",
            reason: err instanceof Error ? err.message : String(err),
            metadata: { connector_id: credRow.connector_id },
          },
          tx,
        );
        const connector = await getConnector(tenant_id, connectorId, tx);
        if (connector) {
          await flagConnectorAuthFailure(tx, connector, {
            reason: "oauth2 refresh token rejected by the IdP",
          });
        }
      });
      return decrypted;
    }
  });
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
        await withActiveTenantJobContext(job.data, opts.db, async () => {
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

export async function handleRefreshJob(db: Db, data: RefreshOAuthJob): Promise<void> {
  return withActiveTenantJobContext(data, db, async () => {
    const rows = await db
      .select()
      .from(vaultItems)
      .where(and(eq(vaultItems.id, data.credential_id), eq(vaultItems.tenant_id, data.tenant_id)))
      .limit(1);
    const row = rows[0];
    if (!row) return;
    if (!row.oauth2_refresh_ciphertext) return;
    if (row.connector_id == null) return;
    const { getCredentialForConnector } = await import("../service.ts");
    const fetched = await getCredentialForConnector(
      data.tenant_id,
      row.connector_id,
      row.environment as "dev" | "prod",
      db,
    );
    if (fetched?.value.mode !== "oauth2") return;
    await refreshIfStale(db, data.tenant_id, fetched.row, fetched.value);
  });
}
