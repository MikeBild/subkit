import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../../audit/types.ts";
import type { Config } from "../../config/schema.ts";
import type { Db, Executor } from "../../db/client.ts";
import { admitPersistentRateLimits, rateLimitBucketKey } from "../../db/rate-limits.ts";
import { mcpOauthClients, tenants } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";

export interface RegisterClientInput {
  client_name?: string | undefined;
  client_uri?: string | undefined;
  redirect_uris: string[];
  grant_types?: string[] | undefined;
  token_endpoint_auth_method?: string | undefined;
  scope?: string | undefined;
  software_id?: string | undefined;
  requestSource?: string | undefined;
  registration_peer?: string | undefined;
}

export interface RegisterClientResult {
  client_id: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
  client_name?: string;
  client_uri?: string;
}

export class McpClientAdmissionError extends Error {
  readonly oauth_error = "temporarily_unavailable";
  constructor(
    readonly reason: "policy" | "rate",
    readonly retry_after_seconds?: number,
  ) {
    super(
      reason === "rate"
        ? "MCP client registration is temporarily rate limited"
        : "MCP client registration is unavailable under the operator policy",
    );
    this.name = "McpClientAdmissionError";
  }
}

async function admitRegistration(exec: Executor, config: Config, peer: string): Promise<void> {
  let hosted = config.auth.hosted.enabled;
  if (!hosted) {
    // tenant-filter:exempt — pre-tenant client registration detects retained hosted tenancy so disabling signup cannot bypass persistent protection.
    const [tenant] = await exec
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.origin, "self_service"))
      .limit(1);
    hosted = !!tenant;
  }
  if (!hosted) return;
  const policy = config.auth.hosted.admission;
  if (
    !config.auth.session.secret ||
    policy.mcp_clients_per_peer_per_minute <= 0 ||
    policy.mcp_clients_per_minute <= 0 ||
    policy.retained_mcp_clients <= 0
  )
    throw new McpClientAdmissionError("policy");
  await exec.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('hosted-mcp-client-admission', 0))`,
  );
  // tenant-filter:exempt — MCP clients are global retained registrations; their stock quota applies before authorization selects a tenant.
  const [count] = await exec.select({ count: sql<number>`count(*)::int` }).from(mcpOauthClients);
  if ((count?.count ?? 0) >= policy.retained_mcp_clients)
    throw new McpClientAdmissionError("policy");
  const allowed = await admitPersistentRateLimits(
    [
      {
        bucket_key: rateLimitBucketKey(
          config.auth.session.secret,
          "admission",
          "mcp_client_global",
        ),
        max: policy.mcp_clients_per_minute,
      },
      {
        bucket_key: rateLimitBucketKey(
          config.auth.session.secret,
          "admission",
          `mcp_client_peer:${peer}`,
        ),
        max: policy.mcp_clients_per_peer_per_minute,
      },
    ],
    exec,
  );
  if (!allowed.allowed) throw new McpClientAdmissionError("rate", allowed.retry_after_seconds);
}

export async function registerMcpClient(
  db: Db,
  config: Config,
  input: RegisterClientInput,
): Promise<RegisterClientResult> {
  const authMethod = input.token_endpoint_auth_method ?? "none";
  if (authMethod !== "none")
    throw Object.assign(
      new Error("invalid_client_metadata: only token_endpoint_auth_method=none is supported"),
      { oauth_error: "invalid_client_metadata" },
    );
  const clientId = randomBytes(16).toString("hex");
  const grantTypes = input.grant_types ?? ["authorization_code", "refresh_token"];
  const rawScope = input.scope ?? (config.auth.mcp_oauth.scopes_supported.join(" ") || "mcp:read");
  const scope = [...new Set(rawScope.split(/\s+/).filter(Boolean))].join(" ");
  const requestSource = input.requestSource ?? "api";
  await db.transaction(async (tx) => {
    await admitRegistration(tx, config, input.registration_peer ?? "unknown");
    await tx.insert(mcpOauthClients).values({
      client_id: clientId,
      redirect_uris: input.redirect_uris,
      grant_types: grantTypes,
      token_endpoint_auth_method: "none",
      scope,
      client_name: input.client_name ?? null,
      client_uri: input.client_uri ?? null,
      software_id: input.software_id ?? null,
      registration_source: "dcr",
    });
    await auditAwait(
      {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: "system",
        action: AuditAction.MCP_OAUTH_CLIENT_REGISTERED,
        resource_type: "mcp_oauth_client",
        resource_id: clientId,
        result: "success",
        metadata: {
          request_source: requestSource,
          client_id: clientId,
          scope,
          grant_types: grantTypes,
        },
      },
      tx,
    );
  });
  logger.info({
    module: "mcp_oauth",
    action: "client.registered",
    msg: "MCP OAuth client registered",
    client_id: clientId,
  });
  return {
    client_id: clientId,
    redirect_uris: input.redirect_uris,
    grant_types: grantTypes,
    token_endpoint_auth_method: "none",
    scope,
    ...(input.client_name ? { client_name: input.client_name } : {}),
    ...(input.client_uri ? { client_uri: input.client_uri } : {}),
  };
}
