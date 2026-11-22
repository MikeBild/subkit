import { and, eq } from "drizzle-orm";
import { type Actor, auditActor } from "../audit/actor.ts";
import {
  AuditAction,
  auditAwait,
  recordOAuthClientRegistered,
  recordOAuthClientRegistrationFailed,
} from "../audit/index.ts";
import type { AuditActorType } from "../audit/types.ts";
import * as credsvc from "../credentials/index.ts";
import {
  DynamicRegistrationError,
  dynamicallyRegisterClient,
  runClientCredentialsJsonGrant,
  startAuthorizationCode,
} from "../credentials/index.ts";
import type { Db } from "../db/client.ts";
import { connectorOauthStates, connectors } from "../db/schema/index.ts";
import { BadRequestError, HttpError, NotFoundError } from "../http/errors.ts";
import { logger } from "../logging/index.ts";
import { now } from "../utils/clock.ts";
import type { OAuthFlowOrigin } from "./oauth-origin.ts";
import { completeConnectorReauthorization } from "./reauth.ts";
import { getConnector } from "./service.ts";
import { connectorSignIn } from "./sign-in.ts";
import {
  connectorOAuthGrantType,
  getConnectorTemplateSnapshot,
  resolveConnectorOAuthConfigDetailed,
} from "./template-binding.ts";

type OAuthDanceResult =
  | { kind: "browser"; authorization_url: string; state: string }
  | { kind: "done" };

interface BeginConnectorOAuthDanceOptions {
  db: Db;
  tenant_id: string;
  connector_id: string;
  actor_id: string | null;
  actor?: Actor | null;
  actor_type?: AuditActorType;
  redirect_uri: string;
  origin: OAuthFlowOrigin;
}

export async function beginConnectorOAuthDance(
  opts: BeginConnectorOAuthDanceOptions,
): Promise<OAuthDanceResult> {
  const { db, tenant_id, connector_id, actor_id, redirect_uri, origin } = opts;
  const audit_actor =
    opts.actor !== undefined
      ? auditActor(opts.actor)
      : opts.actor_type === "unknown"
        ? { actor_type: "unknown" as const, actor_id: null }
        : opts.actor_type
          ? { actor_type: opts.actor_type, actor_id }
          : actor_id
            ? { actor_type: "unknown" as const, actor_id: null }
            : auditActor(null);

  let connector = await getConnector(tenant_id, connector_id, db);
  if (!connector) throw new NotFoundError("connector");

  const signIn = connectorSignIn(connector);
  if (signIn?.kind !== "oauth") {
    throw signIn
      ? new HttpError(
          400,
          "sign_in_route_mismatch",
          "this connector does not sign in through oauth/start",
          { hint: `start its sign-in at ${signIn.start}` },
        )
      : new HttpError(
          400,
          "no_browser_sign_in",
          connectorOAuthGrantType(connector) === "cognito_user_password"
            ? "connector uses Cognito USER_PASSWORD_AUTH (cognito_user_password), not a browser authorization-code flow — re-issue its credential (email + password) instead of opening a sign-in link"
            : "this connector has no browser sign-in — store its credential instead",
        );
  }

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
      const result = await dynamicallyRegisterClient(
        {
          issuerUrl,
          clientMetadata: { redirect_uris: [redirect_uri] },
          allowInsecureRequests: new URL(issuerUrl).protocol === "http:",
        },
        { tenant_id, exec: db },
      );
      const resolvedRegistrationHost = new URL(result.registrationEndpoint).host;
      registrationEndpointHost = resolvedRegistrationHost;

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
          ...audit_actor,
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
        ...audit_actor,
        connector_id,
        issuer_url_host: issuerHost,
        registration_endpoint_host: registrationEndpointHost,
        error_code: errorCode,
        executor: db,
      });
      throw err;
    }
  }

  const resolution = await resolveConnectorOAuthConfigDetailed(db, tenant_id, connector);
  if (!resolution.ok) {
    if (resolution.missing === "template_oauth_credentials") {
      throw new HttpError(
        400,
        "bad_request",
        `template "${connector.template_slug}" requires tenant OAuth client credentials, and none are stored`,
        {
          hint: `run \`subkit connector-templates set-oauth ${connector.template_slug}\` (POST /v1/connector-templates/${connector.template_slug}/oauth-credentials), then retry oauth/start`,
        },
      );
    }
    throw new BadRequestError(
      resolution.missing === "issuer_url"
        ? "connector is missing oauth2 config: no issuer_url on config.oauth or the bound template"
        : "connector is missing oauth2 config: no client_id on config.oauth, the bound template, or dynamic registration",
    );
  }
  const cfg = resolution.config;

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
    const bundle = await runClientCredentialsJsonGrant(
      {
        token_endpoint: tokenEndpoint,
        body_mapping: bodyMapping,
        response_format: cfg.token_response_format ?? "raw",
        token_response_ttl_ms: cfg.token_response_ttl_ms ?? 86_400_000,
        extra_token_headers: cfg.extra_token_headers,
      },
      { tenant_id, exec: db },
    );
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
    await completeConnectorReauthorization(db, {
      tenant_id,
      connector_id,
      actor_id,
      ...("actor" in opts ? { actor: opts.actor } : {}),
      ...(opts.actor_type ? { actor_type: opts.actor_type } : {}),
    });
    await auditAwait(
      {
        tenant_id,
        ...audit_actor,
        action: AuditAction.VAULT_ITEM_REFRESHED,
        resource_type: "vault_item",
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
  const started = await startAuthorizationCode(cfgWithRedirect, { tenant_id, exec: db });
  await db.insert(connectorOauthStates).values({
    tenant_id,
    connector_id,
    state: started.state,
    code_verifier: started.code_verifier,
    redirect_uri,
    expires_at: new Date(now() + 10 * 60_000),
    requested_scopes: cfg.scope ?? null,
    origin,
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
