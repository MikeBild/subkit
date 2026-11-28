import {
  recordConnectorMcpAuthorizationFailed,
  recordConnectorMcpAuthorizationStarted,
} from "../../../audit/index.ts";
import {
  connectorSignIn,
  discardMcpOAuthState,
  getConnector,
  insertMcpOAuthState,
  mcpSignInStartSteps,
  mcpSignInTransition,
  type OAuthFlowOrigin,
  readMcpAuthorizationUrl,
} from "../../../connectors/index.ts";
import type { Db } from "../../../db/index.ts";
import { logger } from "../../../logging/index.ts";
import {
  buildMcpOAuthRedirectUri,
  getMcpConnector,
  MCP_CREDENTIAL_ENVIRONMENT,
  makeMcpOAuthProvider,
  mcpLocalScope,
  redactUpstreamDetail,
  sdkAuth,
} from "../../../mcp/index.ts";
import type { RequestSource } from "../../../observability/index.ts";
import { now } from "../../../utils/index.ts";

export const LOG_MODULE = "mcp_oauth";

const STATE_TTL_MS = 10 * 60_000;

export function signInStateAfter(event: { type: "consent_granted" } | { type: "sign_in_failed" }) {
  const step = mcpSignInTransition("awaiting_consent", event);
  return step.ok ? step.to : step.from;
}

export type McpAuthorizationStart =
  | { ok: true; flow: { authorization_url: string; state: string } }
  | { ok: false; failure: "not_found" }
  | { ok: false; failure: "not_this_route"; route: string | null }
  | { ok: false; failure: "no_public_address" }
  | { ok: false; failure: "start_failed" };

export async function startMcpAuthorization(p: {
  db: Db;
  req: Request;
  tenant_id: string;
  connector_id: string;
  actor_id: string | null;
  actor_type: "user" | "system_account" | null;
  origin: OAuthFlowOrigin;
  request_source: RequestSource;
}): Promise<McpAuthorizationStart> {
  const { db, tenant_id, connector_id: id, actor_id } = p;

  const connector = await getConnector(tenant_id, id, db);
  if (!connector) return { ok: false, failure: "not_found" };
  const signIn = connectorSignIn(connector);
  if (signIn?.kind !== "mcp") {
    return { ok: false, failure: "not_this_route", route: signIn?.start ?? null };
  }
  const server = await getMcpConnector(db, tenant_id, id);
  if (!server) return { ok: false, failure: "not_found" };
  const auth = server.auth;
  if (auth.kind !== "oauth2") return { ok: false, failure: "not_this_route", route: null };

  const redirect_uri = buildMcpOAuthRedirectUri({ req: p.req });
  if (!redirect_uri) return { ok: false, failure: "no_public_address" };

  const state = crypto.randomUUID();

  await insertMcpOAuthState(db, {
    tenant_id,
    connector_id: id,
    state,
    code_verifier: "",
    redirect_uri,
    requested_scopes: auth.scope ?? null,
    started_by_actor_id: actor_id,
    started_by_actor_type: p.actor_type,
    origin: p.origin,
    expires_at: new Date(now() + STATE_TTL_MS),
  });

  const issuerForAudit = auth.issuer ?? server.url;
  const local_mcp = mcpLocalScope(server);
  const local_target = Boolean(local_mcp);
  try {
    const provider = makeMcpOAuthProvider({
      db,
      tenant_id,
      connector_id: id,
      environment: MCP_CREDENTIAL_ENVIRONMENT,
      redirect_uri,
      state,
      auth,
      interactive: true,
      request_source: p.request_source,
      ...(local_mcp ? { local_mcp } : {}),
    });
    const result = await sdkAuth(provider, { serverUrl: server.url, fetchFn: provider.fetch });
    if (result !== "REDIRECT") {
      throw new Error(`unexpected auth() result for interactive flow: ${result}`);
    }

    const lifecycle = mcpSignInStartSteps(connector.needs_reauth ? "needs_sign_in" : "connected", {
      registered_client: provider.registeredClient,
    });
    const authorizationUrl = await readMcpAuthorizationUrl(db, tenant_id, state);
    if (!authorizationUrl) {
      throw new Error("authorization URL was not persisted by the OAuth provider");
    }

    await recordConnectorMcpAuthorizationStarted({
      tenant_id,
      actor_id,
      ...(p.actor_type ? { actor_type: p.actor_type } : {}),
      request_source: p.request_source,
      connector_id: id,
      connector_slug: server.slug,
      issuer: issuerForAudit,
      executor: db,
    });

    logger.info({
      module: LOG_MODULE,
      action: "authorize.started",
      msg: "issued interactive OAuth authorization URL for external MCP server",
      tenant_id,
      connector_id: id,
      local_target,
      connector_slug: server.slug,
      origin: p.origin,
      state_prefix: state.slice(0, 8),
      sign_in_state: lifecycle.state,
      sign_in_path: lifecycle.path,
      registered_client: provider.registeredClient,
    });

    return { ok: true, flow: { authorization_url: authorizationUrl, state } };
  } catch (err) {
    await discardMcpOAuthState(db, tenant_id, state);
    await recordConnectorMcpAuthorizationFailed({
      tenant_id,
      actor_id,
      ...(p.actor_type ? { actor_type: p.actor_type } : {}),
      request_source: p.request_source,
      connector_id: id,
      connector_slug: server.slug,
      issuer: issuerForAudit,
      reason: "discovery_or_registration_failed",
      executor: db,
    });
    logger.warn({
      module: LOG_MODULE,
      action: "authorize.failed",
      msg: "interactive OAuth authorization could not be started for external MCP server",
      tenant_id,
      connector_id: id,
      local_target,
      connector_slug: server.slug,
      state_prefix: state.slice(0, 8),
      sign_in_state: signInStateAfter({ type: "sign_in_failed" }),
      error_class: err instanceof Error ? err.name : "Error",
      error: redactUpstreamDetail(err instanceof Error ? err.message : String(err)),
    });
    return { ok: false, failure: "start_failed" };
  }
}
