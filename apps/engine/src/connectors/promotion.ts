import { createHash } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import {
  type CredentialPlaintext,
  getCredentialForConnector,
  upsertCredential,
} from "../credentials/index.ts";
import type { CredentialMode, DecryptedCredential } from "../credentials/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import {
  connectorPromotions,
  connectors,
  credentials,
  endUserCredentials,
} from "../db/schema/index.ts";

export type ConnectorPromotionStrategy = "copy" | "move";

export interface ConnectorPromotionCredentialMapping {
  mode: CredentialMode;
  source_credential_id: string;
  target_credential_id: string;
}

export interface ConnectorPromotionResult {
  strategy: ConnectorPromotionStrategy;
  source_connector_id: string;
  target_connector_id: string;
  source_environment: "dev";
  target_environment: "prod";
  source_retained: boolean;
  credential_mappings: ConnectorPromotionCredentialMapping[];
  idempotent_replay: boolean;
  audit_log_ids: string[];
}

export type ConnectorPromotionErrorCode =
  | "source_not_found"
  | "source_not_dev"
  | "target_exists"
  | "oauth_copy_unsupported"
  | "end_user_credential_copy_unsupported"
  | "credential_slot_conflict"
  | "idempotency_conflict";

export class ConnectorPromotionError extends Error {
  readonly code: ConnectorPromotionErrorCode;

  constructor(code: ConnectorPromotionErrorCode, message: string) {
    super(message);
    this.name = "ConnectorPromotionError";
    this.code = code;
  }
}

export interface PromoteConnectorInput {
  tenant_id: string;
  source_connector_id: string;
  strategy: ConnectorPromotionStrategy;
  idempotency_key: string;
  actor_id: string | null;
  actor_type?: "user" | "system_account" | "system";
  request_source: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function replayResult(response: Record<string, unknown>): ConnectorPromotionResult {
  return {
    ...(response as unknown as ConnectorPromotionResult),
    idempotent_replay: true,
  };
}

function copyableCredential(value: DecryptedCredential): CredentialPlaintext {
  if (value.mode === "oauth2" || value.mode === "oauth2_client") {
    throw new ConnectorPromotionError(
      "oauth_copy_unsupported",
      "OAuth credentials must be moved because copied token state cannot be refreshed safely",
    );
  }
  if (value.mode === "token_mint") {
    return {
      mode: "token_mint",
      access_token: "",
      refresh_token: null,
      expires_at: null,
      shape: value.shape,
      mint_endpoint: value.mint_endpoint,
      credentials: value.credentials,
      token_path: value.token_path,
      ...(value.refresh_token_path !== undefined
        ? { refresh_token_path: value.refresh_token_path }
        : {}),
      ...(value.expires_in_path !== undefined ? { expires_in_path: value.expires_in_path } : {}),
      ...(value.expires_at_path !== undefined ? { expires_at_path: value.expires_at_path } : {}),
      ...(value.header_template !== undefined ? { header_template: value.header_template } : {}),
    };
  }
  return value;
}

export async function promoteConnector(
  input: PromoteConnectorInput,
  exec?: Executor,
): Promise<ConnectorPromotionResult> {
  const db = exec ?? getDb();
  const idempotencyHash = digest(input.idempotency_key);
  const requestFingerprint = digest(
    JSON.stringify({
      source_connector_id: input.source_connector_id,
      target_environment: "prod",
      strategy: input.strategy,
    }),
  );

  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${idempotencyHash}))`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${input.tenant_id}:${input.source_connector_id}`}))`,
    );

    const priorRows = await tx
      .select()
      .from(connectorPromotions)
      .where(
        and(
          eq(connectorPromotions.tenant_id, input.tenant_id),
          eq(connectorPromotions.idempotency_key_hash, idempotencyHash),
        ),
      )
      .limit(1);
    const prior = priorRows[0];
    if (prior) {
      if (prior.request_fingerprint !== requestFingerprint) {
        throw new ConnectorPromotionError(
          "idempotency_conflict",
          "the idempotency key was already used for a different promotion request",
        );
      }
      return replayResult(prior.response);
    }

    const sourceRows = await tx
      .select()
      .from(connectors)
      .where(
        and(
          eq(connectors.tenant_id, input.tenant_id),
          eq(connectors.id, input.source_connector_id),
          isNull(connectors.deleted_at),
        ),
      )
      .limit(1);
    const source = sourceRows[0];
    if (!source) {
      throw new ConnectorPromotionError("source_not_found", "source connector not found");
    }
    if (source.environment !== "dev") {
      throw new ConnectorPromotionError(
        "source_not_dev",
        "only DEV connectors can be promoted to PROD",
      );
    }

    const targetRows = await tx
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.tenant_id, input.tenant_id),
          eq(connectors.slug, source.slug),
          eq(connectors.environment, "prod"),
          isNull(connectors.deleted_at),
        ),
      )
      .limit(1);
    if (targetRows[0]) {
      throw new ConnectorPromotionError(
        "target_exists",
        `an active PROD connector with slug "${source.slug}" already exists`,
      );
    }

    const credentialRows = await tx
      .select()
      .from(credentials)
      .where(
        and(eq(credentials.tenant_id, input.tenant_id), eq(credentials.connector_id, source.id)),
      );
    if (credentialRows.some((row) => row.environment !== "dev")) {
      throw new ConnectorPromotionError(
        "credential_slot_conflict",
        "the source connector has credential state outside DEV",
      );
    }

    let targetConnectorId = source.id;
    const credentialMappings: ConnectorPromotionCredentialMapping[] = [];
    const auditLogIds: string[] = [];

    if (input.strategy === "copy") {
      // Rows only exist here from versions that still had the write endpoint;
      // the feature was never honoured on the execution path and the route is
      // gone. The guard stays so an old row cannot be silently duplicated into
      // a promoted connector and look effective there either.
      const endUserRows = await tx
        .select({ id: endUserCredentials.id })
        .from(endUserCredentials)
        .where(
          and(
            eq(endUserCredentials.tenant_id, input.tenant_id),
            eq(endUserCredentials.connector_id, source.id),
          ),
        )
        .limit(1);
      if (endUserRows[0]) {
        throw new ConnectorPromotionError(
          "end_user_credential_copy_unsupported",
          "connectors with end-user credentials must be moved to preserve credential bindings",
        );
      }
      if (
        source.auth_type === "oauth2" ||
        credentialRows.some((row) => row.mode === "oauth2" || row.mode === "oauth2_client")
      ) {
        throw new ConnectorPromotionError(
          "oauth_copy_unsupported",
          "OAuth connectors must be moved because copied token state cannot be refreshed safely",
        );
      }
      if (credentialRows.filter((row) => row.mode !== "oauth2_client").length > 1) {
        throw new ConnectorPromotionError(
          "credential_slot_conflict",
          "the source connector has multiple primary credentials",
        );
      }

      const inserted = await tx
        .insert(connectors)
        .values({
          tenant_id: source.tenant_id,
          slug: source.slug,
          display_name: source.display_name,
          driver: source.driver,
          environment: "prod",
          auth_type: source.auth_type,
          config: source.config,
          base_url: source.base_url,
          dsn: source.dsn,
          operator_quirks: source.operator_quirks,
          self_description: source.self_description,
          template_slug: source.template_slug,
          template_name: source.template_name,
          template_source: source.template_source,
          template_version: source.template_version,
          template_snapshot: source.template_snapshot,
          auto_refresh_cron: source.auto_refresh_cron,
          last_ingested_at: source.last_ingested_at,
          circuit_state: source.circuit_state,
          circuit_opened_at: source.circuit_opened_at,
          circuit_failure_count: source.circuit_failure_count,
          circuit_threshold: source.circuit_threshold,
          circuit_reset_ms: source.circuit_reset_ms,
          needs_reauth: source.needs_reauth,
          auth_failed_at: source.auth_failed_at,
          auth_failed_reason: source.auth_failed_reason,
          health_state: source.health_state,
          health_reason: source.health_reason,
          health_error_code: source.health_error_code,
          health_changed_at: source.health_changed_at,
          sunset_at: source.sunset_at,
          successor_uri: source.successor_uri,
        })
        .returning({ id: connectors.id });
      const target = inserted[0];
      assertInsertRow(target, "connectors");
      targetConnectorId = target.id;

      const primary = await getCredentialForConnector(input.tenant_id, source.id, "dev", tx);
      if (primary) {
        const copied = await upsertCredential(
          {
            tenant_id: input.tenant_id,
            connector_id: targetConnectorId,
            environment: "prod",
            mode: primary.value.mode,
            value: copyableCredential(primary.value),
            actor_id: input.actor_id,
            source: "connector_promotion",
          },
          tx,
        );
        credentialMappings.push({
          mode: copied.mode,
          source_credential_id: primary.row.id,
          target_credential_id: copied.id,
        });
      }
    } else {
      await tx
        .update(connectors)
        .set({ environment: "prod", updated_at: new Date() })
        .where(and(eq(connectors.tenant_id, input.tenant_id), eq(connectors.id, source.id)));
      await tx
        .update(credentials)
        .set({ environment: "prod", updated_at: new Date() })
        .where(
          and(
            eq(credentials.tenant_id, input.tenant_id),
            eq(credentials.connector_id, source.id),
            eq(credentials.environment, "dev"),
          ),
        );
      for (const credential of credentialRows) {
        credentialMappings.push({
          mode: credential.mode as CredentialMode,
          source_credential_id: credential.id,
          target_credential_id: credential.id,
        });
      }
    }

    const connectorAudit = await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_type ?? (input.actor_id ? "user" : "system"),
        actor_id: input.actor_id,
        action: AuditAction.CONNECTOR_ENVIRONMENT_PROMOTED,
        resource_type: "connector",
        resource_id: targetConnectorId,
        result: "success",
        before: { connector_id: source.id, environment: "dev" },
        after: { connector_id: targetConnectorId, environment: "prod" },
        metadata: {
          strategy: input.strategy,
          source_retained: input.strategy === "copy",
          request_source: input.request_source,
          idempotency_key_hash: idempotencyHash,
        },
      },
      tx,
    );
    auditLogIds.push(connectorAudit.id);

    for (const mapping of credentialMappings) {
      const credentialAudit = await auditAwait(
        {
          tenant_id: input.tenant_id,
          actor_type: input.actor_type ?? (input.actor_id ? "user" : "system"),
          actor_id: input.actor_id,
          action: AuditAction.CREDENTIAL_ENVIRONMENT_PROMOTED,
          resource_type: "credential",
          resource_id: mapping.target_credential_id,
          result: "success",
          before: { credential_id: mapping.source_credential_id, environment: "dev" },
          after: { credential_id: mapping.target_credential_id, environment: "prod" },
          metadata: {
            connector_id: targetConnectorId,
            mode: mapping.mode,
            strategy: input.strategy,
            request_source: input.request_source,
          },
        },
        tx,
      );
      auditLogIds.push(credentialAudit.id);
    }

    const result: ConnectorPromotionResult = {
      strategy: input.strategy,
      source_connector_id: source.id,
      target_connector_id: targetConnectorId,
      source_environment: "dev",
      target_environment: "prod",
      source_retained: input.strategy === "copy",
      credential_mappings: credentialMappings,
      idempotent_replay: false,
      audit_log_ids: auditLogIds,
    };
    await tx.insert(connectorPromotions).values({
      tenant_id: input.tenant_id,
      idempotency_key_hash: idempotencyHash,
      request_fingerprint: requestFingerprint,
      source_connector_id: source.id,
      target_connector_id: targetConnectorId,
      strategy: input.strategy,
      response: result as unknown as Record<string, unknown>,
    });
    return result;
  });
}
