import { sql } from "drizzle-orm";
import { type Actor, auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { buildOAuthRedirectUri, OAUTH_CALLBACK_PATH } from "../credentials/oauth2/redirect-uri.ts";
import type { DecryptedCredential } from "../credentials/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { logger } from "../logging/index.ts";
import { invalidateTenantState } from "../operator/index.ts";
import {
  type ConnectorAuthFailedPayload,
  ConnectorAuthFailedPayloadSchema,
} from "../pubsub/types.ts";
import { resetCircuitBreaker } from "./circuit-breaker.ts";
import type { ConnectorHealth } from "./health.ts";
import { setConnectorHealth } from "./health-state.ts";
import { MCP_SIGN_IN_PENDING_REASON } from "./mcp-sign-in-state.ts";
import { connectorSignIn } from "./sign-in.ts";
import type { ConnectorView } from "./types.ts";

export async function markConnectorNeedsReauth(
  db: Executor,
  tenant_id: string,
  connector_id: string,
  reason: string,
): Promise<{ transitioned: boolean }> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE connectors
       SET needs_reauth = true,
           auth_failed_at = now(),
           auth_failed_reason = ${reason}
     WHERE id = ${connector_id}
       AND tenant_id = ${tenant_id}
       AND needs_reauth = false
    RETURNING id
  `);
  const transitioned = rows.rows.length > 0;
  if (transitioned) {
    logger.warn({
      module: "connectors",
      action: "connector.reauth.marked",
      msg: "connector marked needs_reauth",
      tenant_id,
      connector_id,
      reason,
    });
  }
  return { transitioned };
}

export { connectorSignsInInteractively } from "./mcp-sign-in-state.ts";

export async function holdConnectorForSignIn(
  db: Executor,
  connector: Pick<
    ConnectorView,
    "tenant_id" | "id" | "driver" | "auth_type" | "config" | "template_snapshot"
  >,
): Promise<{ state: "needs_sign_in"; start: string | null }> {
  await markConnectorNeedsReauth(db, connector.tenant_id, connector.id, MCP_SIGN_IN_PENDING_REASON);
  return { state: "needs_sign_in", start: connectorSignIn(connector)?.start ?? null };
}

export async function clearConnectorReauth(
  db: Executor,
  tenant_id: string,
  connector_id: string,
  opts?: { actor_id?: string | null; actor?: Actor | null; actor_type?: AuditActorType },
): Promise<void> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE connectors
       SET needs_reauth = false,
           auth_failed_at = NULL,
           auth_failed_reason = NULL
     WHERE id = ${connector_id}
       AND tenant_id = ${tenant_id}
       AND needs_reauth = true
    RETURNING id
  `);
  if (rows.rows.length === 0) return;
  invalidateTenantState(tenant_id);
  logger.info({
    module: "connectors",
    action: "connector.reauth.cleared",
    msg: "connector reauth flag cleared",
    tenant_id,
    connector_id,
  });
  const actor_id = opts?.actor_id ?? null;
  const actorFields =
    opts?.actor !== undefined
      ? auditActor(opts.actor)
      : opts?.actor_type === "unknown"
        ? { actor_type: "unknown" as const, actor_id: null }
        : opts?.actor_type
          ? { actor_type: opts.actor_type, actor_id }
          : actor_id
            ? { actor_type: "unknown" as const, actor_id: null }
            : auditActor(null);
  await auditAwait(
    {
      tenant_id,
      ...actorFields,
      action: AuditAction.CONNECTOR_REAUTH_CLEARED,
      resource_type: "connector",
      resource_id: connector_id,
      result: "success",
      reason: "credential_recovered",
      metadata: {},
    },
    db,
  );
}

export async function completeConnectorReauthorization(
  db: Db,
  p: {
    tenant_id: string;
    connector_id: string;
    actor_id?: string | null;
    actor?: Actor | null;
    actor_type?: AuditActorType;
  },
): Promise<void> {
  const actor_id = p.actor_id ?? null;
  await clearConnectorReauth(db, p.tenant_id, p.connector_id, {
    actor_id,
    ...(p.actor !== undefined ? { actor: p.actor } : {}),
    ...(p.actor_type ? { actor_type: p.actor_type } : {}),
  });
  const actorFields =
    p.actor !== undefined
      ? auditActor(p.actor)
      : p.actor_type === "unknown"
        ? { actor_type: "unknown" as const, actor_id: null }
        : p.actor_type
          ? { actor_type: p.actor_type, actor_id }
          : actor_id
            ? { actor_type: "unknown" as const, actor_id: null }
            : auditActor(null);
  const stored = await db.execute<{ slug: string }>(sql`
    SELECT slug FROM connectors
     WHERE id = ${p.connector_id} AND tenant_id = ${p.tenant_id}
       AND health_state = 'needs_reauth'
  `);
  const mirrored = stored.rows[0];
  if (mirrored) {
    await setConnectorHealth(
      db,
      { id: p.connector_id, tenant_id: p.tenant_id, slug: mirrored.slug },
      { state: "ok", reason: "re-authorised — a new credential was stored" },
    );
  }
  const previous = await resetCircuitBreaker(db, p.tenant_id, p.connector_id);
  if (!previous) return;
  invalidateTenantState(p.tenant_id);
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      ...actorFields,
      action: AuditAction.CONNECTOR_CIRCUIT_RESET,
      resource_type: "connector",
      resource_id: p.connector_id,
      result: "success",
      reason: "reauthorized",
      metadata: {
        from_state: previous.circuit_state,
        failure_count: previous.circuit_failure_count,
      },
    },
    db,
  );
}

export function settleConnectorReauthorization(
  db: Db,
  p: {
    tenant_id: string;
    connector_id: string;
    actor_id?: string | null;
    actor?: Actor | null;
    actor_type?: AuditActorType;
  },
): Promise<void> {
  return completeConnectorReauthorization(db, p).catch((err) => {
    logger.warn({
      module: "connectors",
      action: "connector.reauthorization.incomplete",
      msg: "credential stored but the sign-in flag / breaker could not be reset",
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

const CALLER_AUTH_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
]);

function lowerNames(record: Record<string, unknown> | undefined): Set<string> {
  return new Set(Object.keys(record ?? {}).map((name) => name.toLowerCase()));
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function requestUsedStoredCredential(p: {
  credential: DecryptedCredential | null;
  home: string | null;
  url: URL;
  caller_headers?: Record<string, unknown> | undefined;
  caller_query?: Record<string, unknown> | undefined;
}): boolean {
  const credential = p.credential;
  if (!credential || credential.mode === "none") return false;
  if (hostOf(p.home) !== p.url.host.toLowerCase()) return false;
  const headers = lowerNames(p.caller_headers);
  for (const name of headers) if (CALLER_AUTH_HEADERS.has(name)) return false;
  if (credential.mode === "header") {
    for (const name of lowerNames(credential.headers)) if (headers.has(name)) return false;
  }
  if (credential.mode === "query") {
    const query = lowerNames(p.caller_query);
    for (const name of lowerNames(credential.query)) if (query.has(name)) return false;
  }
  return true;
}

export interface AuthenticatedCallOutcome {
  status: number;
  health: ConnectorHealth;
  stored_credential_used: boolean;
  body?: unknown;
}

function reportsErrors(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const errors = (body as { errors?: unknown }).errors;
  return Array.isArray(errors) && errors.length > 0;
}

export function callProvedCredentialLive(
  connector: Pick<ConnectorView, "auth_type" | "needs_reauth">,
  outcome: AuthenticatedCallOutcome,
): boolean {
  return (
    connector.needs_reauth &&
    connector.auth_type !== "none" &&
    outcome.stored_credential_used &&
    outcome.status >= 200 &&
    outcome.status < 300 &&
    (outcome.health === "ok" || outcome.health === "deprecated") &&
    !reportsErrors(outcome.body)
  );
}

export function clearReauthIfProved(
  db: Executor,
  connector: Pick<ConnectorView, "tenant_id" | "id" | "auth_type" | "needs_reauth">,
  outcome: AuthenticatedCallOutcome,
): Promise<void> {
  if (!callProvedCredentialLive(connector, outcome)) return Promise.resolve();
  return clearConnectorReauth(db, connector.tenant_id, connector.id).catch((err) => {
    logger.warn({
      module: "connectors",
      action: "connector.reauth.clear_failed",
      msg: "best-effort reauth clear on success failed",
      tenant_id: connector.tenant_id,
      connector_id: connector.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function emitConnectorAuthFailed(
  tx: Executor,
  ev: {
    tenant_id: string;
    connector_id: string;
    connector_slug: string;
    workflow_id?: string | null;
    reason: string;
    reauth_url: string | null;
  },
): Promise<void> {
  const payload: ConnectorAuthFailedPayload = {
    severity: "error",
    workflow_id: ev.workflow_id ?? null,
    connector_id: ev.connector_id,
    connector_slug: ev.connector_slug,
    reason: ev.reason,
    reauth_url: ev.reauth_url,
  };
  await writeEvent(tx, {
    tenant_id: ev.tenant_id,
    channel: "notification.emitted",
    type: "connector.auth_failed",
    payload: ConnectorAuthFailedPayloadSchema.parse(payload),
  });
}

type ReauthConnector = Pick<
  ConnectorView,
  "id" | "slug" | "driver" | "auth_type" | "config" | "template_snapshot"
>;

export function buildReauthUrl(connector: ReauthConnector): {
  method: "oauth2" | "portal_setup";
  reauth_url: string | null;
  instructions: string;
} {
  const signIn = connectorSignIn(connector);
  const method = signIn ? "oauth2" : "portal_setup";
  const redirect_uri = buildOAuthRedirectUri();
  if (!redirect_uri) {
    return {
      method,
      reauth_url: null,
      instructions: "Set server.public_base_url on the engine, then re-authenticate the connector.",
    };
  }
  const origin = redirect_uri.slice(0, -OAUTH_CALLBACK_PATH.length);
  if (signIn) {
    return {
      method,
      reauth_url: `${origin}${signIn.start}`,
      instructions: `Ask the assistant to run request_connector_reauth for '${connector.slug}' to get a one-time sign-in link, or POST this endpoint with an API key.`,
    };
  }
  return {
    method,
    reauth_url: `${origin}/v1/connectors/${encodeURIComponent(connector.id)}/credentials`,
    instructions: `Ask the assistant to run request_connector_reauth for '${connector.slug}' to get a one-time credential-setup link, or POST this endpoint with an API key.`,
  };
}

export async function flagConnectorAuthFailure(
  db: Executor,
  connector: ReauthConnector & Pick<ConnectorView, "tenant_id">,
  opts: { reason: string; workflow_id?: string | null },
): Promise<{ transitioned: boolean }> {
  const result = await db.transaction(async (tx) => {
    const { transitioned } = await markConnectorNeedsReauth(
      tx,
      connector.tenant_id,
      connector.id,
      opts.reason,
    );
    if (transitioned) {
      const reauth = buildReauthUrl(connector);
      await emitConnectorAuthFailed(tx, {
        tenant_id: connector.tenant_id,
        connector_id: connector.id,
        connector_slug: connector.slug,
        workflow_id: opts.workflow_id ?? null,
        reason: opts.reason,
        reauth_url: reauth.reauth_url,
      });
    }
    return { transitioned };
  });
  if (result.transitioned) invalidateTenantState(connector.tenant_id);
  return result;
}
