// Credential persistence for the atomic connector save.
//
// Extracted from save-connector.ts (file-size invariant): handles the
// per-mode credential writes — including the Cognito bootstrap mint —
// that `saveConnectorAtomic` performs after the connector row lands.

import { eq } from "drizzle-orm";

import { runCognitoUserPasswordGrant } from "../../credentials/oauth2/client.ts";
import { upsertCredential } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { connectors as connectorsTable } from "../../db/schema/index.ts";
import type { AtomicCredentialInput } from "./save-connector.ts";

export async function persistCredential(p: {
  tenant_id: string;
  connector_id: string;
  environment: "dev" | "prod";
  actor_id: string | null;
  credential: AtomicCredentialInput;
  /** Connector config — used for `cognito_user_password` to pull
   *  `aws_region` + `client_id` when not on the credential itself. */
  connectorConfig?: Record<string, unknown> | null;
  db: Db;
}): Promise<void> {
  const cred = p.credential;
  // Cognito bootstrap: mint an IdToken before persisting so the row
  // ends up as a regular oauth2 credential (with refresh_token +
  // expires_at). The refresh-worker later rotates via
  // REFRESH_TOKEN_AUTH transparently.
  if (cred.mode === "cognito_user_password") {
    const cfg = (p.connectorConfig ?? {}) as {
      aws_region?: unknown;
      oauth?: { client_id?: unknown; aws_region?: unknown };
    };
    const oauthCfg = (cfg.oauth ?? {}) as { client_id?: unknown; aws_region?: unknown };
    // Accept aws_region from either canonical slot — `config.aws_region`
    // (template-seeded) or `config.oauth.aws_region` (LLM nesting).
    const region =
      cred.aws_region ??
      (typeof cfg.aws_region === "string" ? cfg.aws_region : null) ??
      (typeof oauthCfg.aws_region === "string" ? oauthCfg.aws_region : null);
    const client_id =
      cred.client_id ?? (typeof oauthCfg.client_id === "string" ? oauthCfg.client_id : null);
    if (!region || !client_id) {
      const missingPaths: string[] = [];
      const writes: string[] = [];
      if (!region) {
        missingPaths.push("config.aws_region");
        writes.push("aws_region: <region>");
      }
      if (!client_id) {
        missingPaths.push("config.oauth.client_id");
        writes.push("oauth: { client_id: <id> }");
      }
      throw new Error(
        `cognito_user_password connector is missing ${missingPaths.join(", ")}. ` +
          `Call update_connector_draft({ config: { ${writes.join(", ")} } }) — the credential itself is fine.`,
      );
    }
    const grantParams: Parameters<typeof runCognitoUserPasswordGrant>[0] = {
      region,
      client_id,
      username: cred.username,
      password: cred.password,
      use_access_token: cred.use_access_token === true,
    };
    if (cred.client_secret) grantParams.client_secret = cred.client_secret;
    const bundle = await runCognitoUserPasswordGrant(grantParams);
    await upsertCredential(
      {
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        environment: p.environment,
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: bundle.access_token,
          token_type: bundle.token_type, // "none" — raw JWT in Authorization
          ...(bundle.scope ? { scope: bundle.scope } : {}),
        },
        oauth2_refresh_token: bundle.refresh_token,
        oauth2_expires_at: bundle.expires_at,
        actor_id: p.actor_id,
      },
      p.db,
    );
    // Persist the slots the refresh-worker needs to call REFRESH_TOKEN_AUTH
    // an hour from now: `cognito_username` is required to compute
    // SECRET_HASH on app clients with a secret (without it, refresh
    // returns NotAuthorizedException), and `cognito_use_access_token`
    // preserves the operator's IdToken-vs-AccessToken choice across
    // refresh boundaries. Region is normalised onto the canonical
    // `config.aws_region` slot so the refresh-worker doesn't have to
    // chase nested locations. Client-secret stays where the resolver
    // already reads it (`config.oauth.client_secret` /
    // `templateCreds.client_secret`).
    const nextConfigCognito: Record<string, unknown> = {
      ...((cfg as Record<string, unknown>) ?? {}),
      aws_region: region,
      cognito_username: cred.username,
    };
    if (cred.use_access_token === true) {
      nextConfigCognito.cognito_use_access_token = true;
    } else if (
      "cognito_use_access_token" in (cfg as Record<string, unknown>) &&
      (cfg as Record<string, unknown>).cognito_use_access_token === true
    ) {
      // Operator switched away from AccessToken — clear the prior flag so
      // the next refresh persists the IdToken instead.
      delete nextConfigCognito.cognito_use_access_token;
    }
    await p.db
      .update(connectorsTable)
      .set({ config: nextConfigCognito })
      .where(eq(connectorsTable.id, p.connector_id));
    return;
  }
  if (cred.mode === "aws_sigv4") {
    await upsertCredential(
      {
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        environment: p.environment,
        mode: "aws_sigv4",
        value: {
          mode: "aws_sigv4",
          access_key_id: cred.access_key_id,
          secret_access_key: cred.secret_access_key,
          ...(cred.session_token ? { session_token: cred.session_token } : {}),
        },
        actor_id: p.actor_id,
      },
      p.db,
    );
    return;
  }
  if (cred.mode === "oauth2") {
    // OAuth2 seed: update the saved connector's config.oauth so a
    // subsequent authenticate_oauth call has client_id (+ optional
    // client_secret + endpoints + scopes) to start the dance. No
    // credential row is written here — the OAuth callback route
    // creates it after the operator's browser exchange.
    const cfg = (p.connectorConfig ?? {}) as Record<string, unknown>;
    const existingOauth = (cfg.oauth as Record<string, unknown> | undefined) ?? {};
    const mergedOauth: Record<string, unknown> = {
      ...existingOauth,
      client_id: cred.client_id,
    };
    if (cred.client_secret !== undefined) mergedOauth.client_secret = cred.client_secret;
    if (cred.token_endpoint !== undefined) mergedOauth.token_endpoint = cred.token_endpoint;
    if (cred.authorization_endpoint !== undefined) {
      mergedOauth.authorization_endpoint = cred.authorization_endpoint;
    }
    if (cred.scopes !== undefined) mergedOauth.scope = cred.scopes;
    const nextConfig: Record<string, unknown> = { ...cfg, oauth: mergedOauth };
    await p.db
      .update(connectorsTable)
      .set({ config: nextConfig })
      .where(eq(connectorsTable.id, p.connector_id));
    return;
  }
  const value =
    cred.mode === "bearer"
      ? { mode: "bearer" as const, token: cred.token }
      : cred.mode === "basic"
        ? { mode: "basic" as const, username: cred.username, password: cred.password }
        : cred.mode === "header"
          ? { mode: "header" as const, headers: { [cred.header_name]: cred.header_value } }
          : { mode: "query" as const, query: { [cred.param]: cred.value } };
  await upsertCredential(
    {
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      environment: p.environment,
      mode: cred.mode,
      value,
      actor_id: p.actor_id,
    },
    p.db,
  );
}
