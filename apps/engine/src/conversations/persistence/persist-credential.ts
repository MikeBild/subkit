import { eq } from "drizzle-orm";
import { runCognitoUserPasswordGrant } from "../../credentials/oauth2/client.ts";
import { upsertCredential } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { connectors as connectorsTable } from "../../db/schema/index.ts";
import type { AtomicCredentialInput } from "./save-connector.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mcpAuthBlock(config: Record<string, unknown>): Record<string, unknown> {
  return asRecord(asRecord(config.mcp).auth);
}

export function withMcpOAuthClient(
  config: Record<string, unknown>,
  client_id: string,
): Record<string, unknown> {
  const mcp = asRecord(config.mcp);
  return {
    ...config,
    mcp: { ...mcp, auth: { kind: "oauth2", ...mcpAuthBlock(config), client_id } },
  };
}

export async function persistCredential(p: {
  tenant_id: string;
  connector_id: string;
  environment: "dev" | "prod";
  actor_id: string | null;
  credential: AtomicCredentialInput;
  connectorConfig?: Record<string, unknown> | null;
  driver?: string;
  db: Db;
}): Promise<void> {
  const cred = p.credential;
  if (cred.mode === "cognito_user_password") {
    const cfg = (p.connectorConfig ?? {}) as {
      aws_region?: unknown;
      oauth?: { client_id?: unknown; aws_region?: unknown };
    };
    const oauthCfg = (cfg.oauth ?? {}) as { client_id?: unknown; aws_region?: unknown };
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
    const bundle = await runCognitoUserPasswordGrant(grantParams, {
      tenant_id: p.tenant_id,
      exec: p.db,
    });
    await upsertCredential(
      {
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        environment: p.environment,
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: bundle.access_token,
          token_type: bundle.token_type,
          ...(bundle.scope ? { scope: bundle.scope } : {}),
        },
        oauth2_refresh_token: bundle.refresh_token,
        oauth2_expires_at: bundle.expires_at,
        actor_id: p.actor_id,
      },
      p.db,
    );
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
      delete nextConfigCognito.cognito_use_access_token;
    }
    await p.db
      .update(connectorsTable)
      .set({ config: nextConfigCognito })
      .where(eq(connectorsTable.id, p.connector_id));
    return;
  }
  if (cred.mode === "signed_jwt") {
    await upsertCredential(
      {
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        environment: p.environment,
        mode: "signed_jwt",
        value: cred,
        actor_id: p.actor_id,
      },
      p.db,
    );
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
  if (cred.mode === "oauth2" && p.driver === "mcp") {
    const nextConfig = withMcpOAuthClient(p.connectorConfig ?? {}, cred.client_id);
    await p.db
      .update(connectorsTable)
      .set({ config: nextConfig })
      .where(eq(connectorsTable.id, p.connector_id));
    if (cred.client_secret !== undefined) {
      const issuer = mcpAuthBlock(nextConfig).issuer;
      await upsertCredential(
        {
          tenant_id: p.tenant_id,
          connector_id: p.connector_id,
          environment: p.environment,
          mode: "oauth2_client",
          value: {
            mode: "oauth2_client",
            client_id: cred.client_id,
            client_secret: cred.client_secret,
            ...(typeof issuer === "string" ? { issuer } : {}),
          },
          actor_id: p.actor_id,
        },
        p.db,
      );
    }
    return;
  }
  if (cred.mode === "oauth2") {
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
