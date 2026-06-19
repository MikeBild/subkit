// Shared OAuth2 authorization-code start logic.
//
// `beginConnectorOAuthDance` is the single entry point that both
// authenticated routes and the grant-token browser path call.  It handles:
//   - Dynamic client registration (if needed).
//   - `client_credentials_json` machine path (no browser redirect).
//   - `authorization_code` / PKCE path — inserts a connector_oauth_states
//     row (with `requested_scopes` carried through) and returns the URL.
//
// Extracted from apps/engine/src/http/routes/connectors/oauth.ts so the
// unauthenticated GET /v1/connectors/{id}/oauth/start?grant=… route can
// reuse the exact same dance without duplicating the logic.

import { and, eq } from "drizzle-orm";
import {
  AuditAction,
  auditAwait,
  recordOAuthClientRegistered,
  recordOAuthClientRegistrationFailed,
} from "../audit/index.ts";
import * as credsvc from "../credentials/index.ts";
import {
  DynamicRegistrationError,
  dynamicallyRegisterClient,
  runClientCredentialsJsonGrant,
  startAuthorizationCode,
} from "../credentials/index.ts";
import type { Db } from "../db/client.ts";
import { connectorOauthStates, connectors } from "../db/schema/index.ts";
import { BadRequestError, NotFoundError } from "../http/errors.ts";
import { logger } from "../logging/index.ts";
import { now } from "../utils/clock.ts";
import { getConnector } from "./service.ts";
import { getConnectorTemplateSnapshot, resolveConnectorOAuthConfig } from "./template-binding.ts";

export type OAuthDanceResult =
  | { kind: "browser"; authorization_url: string; state: string }
  | { kind: "done" };

export interface BeginConnectorOAuthDanceOptions {
  db: Db;
  tenant_id: string;
  connector_id: string;
  /** null for the unauthenticated browser-grant path */
  actor_id: string | null;
  redirect_uri: string;
}

/**
 * Execute the OAuth2 start logic for a connector.
 *
 * For `client_credentials_json` connectors: performs the M2M token exchange
 * synchronously and returns `{kind:"done"}`.
 *
 * For authorization-code connectors: inserts a connector_oauth_states row
 * (with `requested_scopes` from the template config) and returns
 * `{kind:"browser", authorization_url, state}`.
 *
 * Throws `NotFoundError` or `BadRequestError` for structural
 * misconfigurations. Propagates OAuth-provider errors as-is.
 */
export async function beginConnectorOAuthDance(
  opts: BeginConnectorOAuthDanceOptions,
): Promise<OAuthDanceResult> {
  const { db, tenant_id, connector_id, actor_id, redirect_uri } = opts;

  let connector = await getConnector(tenant_id, connector_id, db);
  if (!connector) throw new NotFoundError("connector");

  const snapshot = getConnectorTemplateSnapshot(connector);
  const templateOauth = snapshot?.oauth ?? null;
  const oauthBlock = (connector.config?.oauth ?? {}) as Record<string, unknown>;
  const needsDynamicReg =
    templateOauth?.dynamic_registration === true &&
    (oauthBlock.client_id === null || oauthBlock.client_id === undefined);

  if (needsDynamicReg) {
    const connectorForReg = connector;
    const issuerUrl =
      (oauthBlock.issuer_url as string | undefined) ?? templateOauth?.issuer_url ?? "";
    const issuerHost = issuerUrl ? new URL(issuerUrl).host : "";
    let registrationEndpointHost: string | null = null;
    try {
      const result = await dynamicallyRegisterClient({
        issuerUrl,
        clientMetadata: { redirect_uris: [redirect_uri] },
        allowInsecureRequests: new URL(issuerUrl).protocol === "http:",
      });
      const resolvedRegistrationHost = new URL(result.registrationEndpoint).host;
      registrationEndpointHost = resolvedRegistrationHost;

      // Single transaction: credential insert + connector config update +
      // audit row must all land or all roll back.
      const updatedOauthBlock = { ...oauthBlock, client_id: result.clientId };
      const updatedConfig = { ...connectorForReg.config, oauth: updatedOauthBlock };
      await db.transaction(async (tx) => {
        await credsvc.upsertCredential(
          {
            tenant_id,
            connector_id,
            environment: connectorForReg.environment,
            mode: "oauth2_client",
            value: {
              mode: "oauth2_client",
              client_id: result.clientId,
              ...(result.clientSecret ? { client_secret: result.clientSecret } : {}),
            },
            actor_id,
            source: "http_route",
          },
          tx,
        );
        await tx
          .update(connectors)
          .set({ config: updatedConfig, updated_at: new Date() })
          .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, connector_id)));
        await recordOAuthClientRegistered({
          tenant_id,
          actor_id,
          connector_id,
          issuer_url_host: issuerHost,
          registration_endpoint_host: resolvedRegistrationHost,
          executor: tx,
        });
      });
      connector = { ...connectorForReg, config: updatedConfig };

      logger.info({
        module: "oauth",
        action: "oauth.dynamic_registration.completed",
        msg: "dynamic client registered and credential persisted",
        tenant_id,
        connector_id,
        issuer_url_host: issuerHost,
        registration_endpoint_host: registrationEndpointHost,
      });
    } catch (err) {
      const errorCode = err instanceof DynamicRegistrationError ? err.error_code : "unknown";
      await recordOAuthClientRegistrationFailed({
        tenant_id,
        actor_id,
        connector_id,
        issuer_url_host: issuerHost,
        registration_endpoint_host: registrationEndpointHost,
        error_code: errorCode,
        executor: db,
      });
      throw err;
    }
  }

  const cfg = await resolveConnectorOAuthConfig(db, tenant_id, connector);
  if (!cfg) {
    throw new BadRequestError("connector is missing oauth2 config (issuer_url + client_id)");
  }

  // client_credentials_json: M2M exchange — no browser redirect.
  if (cfg.grant_type === "client_credentials_json") {
    const bodyMapping = cfg.token_request_body_mapping;
    if (!bodyMapping || Object.keys(bodyMapping).length === 0) {
      throw new BadRequestError(
        "client_credentials_json connector is missing token_request_body_mapping in config.oauth — " +
          "set client_id and client_secret fields before calling oauth/start",
      );
    }
    const tokenEndpoint = cfg.token_endpoint;
    if (!tokenEndpoint) {
      throw new BadRequestError(
        "client_credentials_json connector is missing config.oauth.token_endpoint",
      );
    }
    const bundle = await runClientCredentialsJsonGrant({
      token_endpoint: tokenEndpoint,
      body_mapping: bodyMapping,
      response_format: cfg.token_response_format ?? "raw",
      token_response_ttl_ms: cfg.token_response_ttl_ms ?? 86_400_000,
      extra_token_headers: cfg.extra_token_headers,
    });
    await credsvc.upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: connector.environment,
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: bundle.access_token,
          token_type: bundle.token_type,
          ...(bundle.scope ? { scope: bundle.scope } : {}),
        },
        oauth2_refresh_token: null,
        oauth2_expires_at: bundle.expires_at,
        actor_id,
        source: "oauth_callback",
      },
      db,
    );
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.CREDENTIAL_OAUTH2_REFRESHED,
        resource_type: "credential",
        resource_id: connector_id,
        result: "success",
        metadata: { grant_type: "client_credentials_json", connector_id },
      },
      db,
    );
    logger.info({
      module: "oauth",
      action: "oauth.client_credentials_json.minted",
      msg: "client_credentials_json token minted and stored",
      tenant_id,
      connector_id,
    });
    return { kind: "done" };
  }

  const cfgWithRedirect = { ...cfg, redirect_uri };
  const started = await startAuthorizationCode(cfgWithRedirect);
  await db.insert(connectorOauthStates).values({
    tenant_id,
    connector_id,
    state: started.state,
    code_verifier: started.code_verifier,
    redirect_uri,
    expires_at: new Date(now() + 10 * 60_000),
    // Carry requested_scopes so the callback can diff against granted.
    requested_scopes: cfg.scope ?? null,
  });
  logger.info({
    module: "oauth",
    action: "oauth.start",
    msg: "issued authorization URL",
    tenant_id,
    connector_id,
    state_prefix: started.state.slice(0, 8),
    redirect_uri,
  });
  return {
    kind: "browser",
    authorization_url: started.authorization_url,
    state: started.state,
  };
}
