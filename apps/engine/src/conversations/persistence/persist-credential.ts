import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { runCognitoUserPasswordGrant } from "../../credentials/oauth2/client.ts";
import { upsertCredential } from "../../credentials/service.ts";
import {
  auditLog,
  connectors as connectorsTable,
  type Db,
  withTenantScope,
  writeAudit,
} from "../../db/index.ts";
import { logger } from "../../logging/index.ts";
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
  correlation_id: string;
  connectorConfig?: Record<string, unknown> | null;
  driver?: string;
  db: Db;
}): Promise<undefined | { credential_persisted: true }> {
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
    return undefined;
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
    return undefined;
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
    return undefined;
  }
  if (cred.mode === "oauth2" && p.driver === "mcp") {
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          "mcp_client_save",
          p.tenant_id,
          p.connector_id,
          p.environment,
          p.correlation_id,
          cred.client_id,
          cred.client_secret ?? null,
        ]),
      )
      .digest("hex");
    const receiptId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const outcome = await withTenantScope(p.db, p.tenant_id, async (tx) => {
      const [connector] = await tx
        .select({ config: connectorsTable.config })
        .from(connectorsTable)
        .where(
          and(eq(connectorsTable.id, p.connector_id), eq(connectorsTable.tenant_id, p.tenant_id)),
        )
        .for("update");
      const [stored] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.id, receiptId), eq(auditLog.tenant_id, p.tenant_id)));
      if (stored) return stored.metadata as { credential_persisted: true };
      const metadata = { credential_persisted: true as const };
      await writeAudit(
        {
          id: receiptId,
          ts: new Date(),
          tenant_id: p.tenant_id,
          actor_type: p.actor_id ? "user" : "system",
          actor_id: p.actor_id,
          action: "connector.mcp_client_saved",
          resource_type: "connector",
          resource_id: p.connector_id,
          result: "success",
          trace_id: p.correlation_id,
          ip: null,
          user_agent: null,
          before: null,
          after: null,
          reason: null,
          metadata,
        },
        tx,
      );
      const nextConfig = withMcpOAuthClient(asRecord(connector?.config), cred.client_id);
      await tx
        .update(connectorsTable)
        .set({ config: nextConfig })
        .where(
          and(eq(connectorsTable.id, p.connector_id), eq(connectorsTable.tenant_id, p.tenant_id)),
        );
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
          tx,
        );
      }
      return metadata;
    });
    logger.info({
      module: "conversation_persistence",
      action: "connector.mcp_client_saved",
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      correlation_id: p.correlation_id,
      receipt_id: receiptId,
    });
    return outcome;
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
    return undefined;
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
  return undefined;
}
