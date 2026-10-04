// Connector re-auth foundation.
//
// A connector credential can go stale at runtime: an OAuth refresh_token is
// revoked, a static API key is rotated upstream, a Seraph login lapses. When
// that happens the connector is *unusable* until a human re-authenticates it.
// This module is the shared substrate for the re-auth feature: it owns the
// `connectors.needs_reauth` state machine, the operator notification, and the
// "where do I click to fix it" URL. Later agents wire these into the request
// dispatcher, the OAuth refresh worker, and the scheduler scan.
//
// State machine (per connector, tenant-scoped):
//   healthy ──auth failure──▶ needs_reauth=true  (markConnectorNeedsReauth)
//   needs_reauth=true ──successful authed call──▶ healthy  (clearConnectorReauth)
//   needs_reauth=true ──a person re-authorised it──▶ healthy
//                                          (completeConnectorReauthorization)
//
// The false→true transition is the *only* edge that emits a notification — a
// failing connector hammered N times per minute must not produce N
// notification storms. `markConnectorNeedsReauth` enforces that edge atomically
// in SQL (`WHERE needs_reauth = false`) and reports whether it transitioned, so
// the caller emits the event exactly once, inside the same transaction.

import { sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { buildOAuthRedirectUri, OAUTH_CALLBACK_PATH } from "../credentials/oauth2/redirect-uri.ts";
import type { DecryptedCredential } from "../credentials/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { logger } from "../logging/logger.ts";
import { invalidateTenantState } from "../operator/index.ts";
import {
  type ConnectorAuthFailedPayload,
  ConnectorAuthFailedPayloadSchema,
} from "../pubsub/types.ts";
import { resetCircuitBreaker } from "./circuit-breaker.ts";
import type { ConnectorHealth } from "./health.ts";
import { setConnectorHealth } from "./health-state.ts";
import { connectorSignIn } from "./sign-in.ts";
import type { ConnectorView } from "./types.ts";

/**
 * Atomic false→true transition for `connectors.needs_reauth`, tenant-scoped.
 *
 * Returns `{ transitioned: true }` ONLY on the false→true edge. When the
 * connector is already flagged (or the row does not exist for this tenant) the
 * UPDATE matches no row and `transitioned` is false — that is the dedup guard
 * that suppresses notification storms. The caller emits the auth-failed event
 * (and only then) when `transitioned` is true, in the SAME transaction.
 */
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

/**
 * Idempotent reset of the re-auth flag, tenant-scoped. Called when a dead
 * credential recovers — a successful authenticated request at runtime, or an
 * in-chat credential rotation. Clears the flag + failure provenance.
 *
 * Only the genuine true→false edge does work: the UPDATE is gated on
 * `needs_reauth = true`, so calling this when the flag is already clear is a
 * cheap no-op (matches no row → early return, no audit). On a real transition
 * it writes its OWN `CONNECTOR_REAUTH_CLEARED` audit row, so clearing this
 * tenant-visible state is ALWAYS audited regardless of caller — the audit is
 * structural, not dependent on a surrounding recorder. Symmetric with the
 * false→true edge in `markConnectorNeedsReauth`.
 *
 * `actor_id` attributes the row to the operator when the clear is driven by an
 * in-chat rotation; omit it for the runtime auto-recovery path (system actor).
 */
export async function clearConnectorReauth(
  db: Executor,
  tenant_id: string,
  connector_id: string,
  opts?: { actor_id?: string | null },
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
  // A connector no longer needing a sign-in is an attention entry leaving:
  // the cached views of this tenant are stale from here on.
  invalidateTenantState(tenant_id);
  logger.info({
    module: "connectors",
    action: "connector.reauth.cleared",
    msg: "connector reauth flag cleared",
    tenant_id,
    connector_id,
  });
  const actor_id = opts?.actor_id ?? null;
  await auditAwait(
    {
      tenant_id,
      actor_type: actor_id ? "user" : "system",
      actor_id,
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

/**
 * What a person's fresh authorization resolves, for every flow that issues or
 * replaces a connector's credential on a person's behalf — the OAuth callback,
 * the MCP authorization callback, the credential-setup portal, the credential
 * route and a re-issue in chat. One funnel, so no surface can store a new
 * credential and leave the connector reading as it did before.
 *
 * It clears the sign-in flag (and the mirror of it in the stored health
 * verdict) and closes the circuit breaker: the failures it counted were
 * against the credential that was just replaced. Each edge writes its own
 * audit row; a connector with nothing to resolve writes none.
 *
 * It does NOT switch a disabled connector on. `enabled` is the one bit only a
 * person sets, and signing in is not that decision.
 *
 * Not for a token refresh: a refresh rotates material without anyone having
 * authorised anything, and proves nothing about a rejected credential.
 */
export async function completeConnectorReauthorization(
  db: Db,
  p: { tenant_id: string; connector_id: string; actor_id?: string | null },
): Promise<void> {
  const actor_id = p.actor_id ?? null;
  await clearConnectorReauth(db, p.tenant_id, p.connector_id, { actor_id });
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
  // An open breaker reads as "degraded" in the reconciled health verdict.
  invalidateTenantState(p.tenant_id);
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: actor_id ? "user" : "system",
      actor_id,
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

/**
 * `completeConnectorReauthorization` for a browser flow whose credential is
 * already stored. Never rejects: past that point the flow has succeeded, and a
 * failure here must not turn into a page that says "nothing was stored". The
 * flag then clears on the next call the stored credential earns
 * (`clearReauthIfProved`), and the log says why it waited.
 */
export function settleConnectorReauthorization(
  db: Db,
  p: { tenant_id: string; connector_id: string; actor_id?: string | null },
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

// Header names that authenticate a request whatever the connector's own
// scheme is. A caller's `Authorization` replaces the stored credential in
// every driver; a cookie or a proxy credential rides beside it.
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

/**
 * Whether a request was authenticated by the STORED credential, with nothing
 * the caller sent standing in for it and at the connector's own host.
 *
 * Asked by the driver that built the request, because only it knows what the
 * credential set and what the caller did: a caller's `Authorization` wins over
 * the stored one, a caller's header or query parameter under the credential's
 * own name can replace or shadow it, and an absolute URL sends the request to
 * a host the stored credential was never issued for. A success under any of
 * those says nothing about the stored credential.
 */
export function requestUsedStoredCredential(p: {
  credential: DecryptedCredential | null;
  /** Where the connector's requests go: its `base_url`, or its endpoint. */
  home: string | null;
  url: URL;
  /** What the caller supplied on top of the connector's own. A query string
   *  the caller wrote into its path counts as its query. */
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

/** What one call against a connector came back with. */
export interface AuthenticatedCallOutcome {
  status: number;
  health: ConnectorHealth;
  /** The driver's verdict from `requestUsedStoredCredential`. */
  stored_credential_used: boolean;
  /** The parsed response body, when the driver has one. */
  body?: unknown;
}

/** A GraphQL endpoint answers 200 to a request it rejected and says so in a
 *  top-level `errors` array — "unauthenticated" among them. */
function reportsErrors(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const errors = (body as { errors?: unknown }).errors;
  return Array.isArray(errors) && errors.length > 0;
}

/**
 * Whether a call proved a flagged credential live: the connector
 * authenticates, the request was signed by the stored credential, the remote
 * answered 2xx, and the answer was not one that only looks like success. An
 * anonymous 200 classifies as `auth_failed` and a GraphQL `errors` reply is a
 * rejection in a 200; neither lifts the flag.
 */
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

/**
 * The re-auth clearing edge, for every surface that reaches a remote: a
 * request step of any driver and `call_connector`. Clears the flag when — and
 * only when — the call proved the stored credential live.
 *
 * Best-effort: the call's own result must not depend on it, so the returned
 * promise never rejects — a caller may await it or let it run — but a failure
 * is logged so a stuck `needs_reauth` flag is observable rather than silently
 * swallowed.
 */
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

/**
 * Emit the operator-facing `connector.auth_failed` notification.
 *
 * Channel is `notification.emitted` — that is the channel index.ts wires into
 * the event-fanout queue (alongside `execution.status`), so the row actually
 * reaches the webhook/notification dispatcher. (`event.emitted` is the generic
 * channel and is NOT wired to fanout; `connector.oauth` is OAuth-flow
 * completion signaling. Self-healing emits `patch.proposed` on this same
 * `notification.emitted` channel — we mirror that.)
 *
 * The payload is parsed through `ConnectorAuthFailedPayloadSchema` — the same
 * schema the published event catalog exposes — so the shape the fanout's
 * extractors depend on is enforced here, not asserted in a comment.
 *
 * MUST be called inside the SAME transaction as markConnectorNeedsReauth so
 * the state flip and the outbox event commit atomically.
 */
export async function emitConnectorAuthFailed(
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

/** The connector fields the re-sign-in route is decided from. */
export type ReauthConnector = Pick<
  ConnectorView,
  "id" | "slug" | "driver" | "auth_type" | "config" | "template_snapshot"
>;

/**
 * Resolve the stable "reconnect here" URL for a connector that needs re-auth.
 *
 * PURE: no DB writes, no token/grant minting. It returns a stable link to the
 * connector's canonical reconnect endpoint; the actual single-use grant token
 * is minted at click-time by `request_connector_reauth`. This is deliberate —
 * pre-minting a grant here would (a) expire (the notification may be acted on
 * minutes/hours later), (b) write an outbox-decoupled row that orphans if the
 * surrounding transaction rolls back. A stable endpoint link has neither
 * failure mode.
 *
 * The route is the connector's own sign-in (`connectorSignIn`, the predicate
 * its `sign_in` field is computed from): `/oauth/start` for a web service,
 * `/mcp/authorize` for an MCP server. A connector with no browser sign-in — a
 * key, machine-to-machine OAuth, a Cognito password grant — reconnects by
 * storing a new credential at `/credentials`.
 *
 * None of these bare endpoint URLs is a click-through browser flow: each is
 * an authenticated POST that rejects an unauthenticated browser hit. The
 * honest instruction for an operator notification is the same for all: ask
 * the assistant to run `request_connector_reauth`, which mints a fresh
 * single-use browser link (`<sign-in route>?grant=…` or
 * `/credentials/setup?grant=…`). `reauth_url` still exposes the bare endpoint
 * so API-key/programmatic callers can hit it directly.
 *
 * Returns `reauth_url: null` only when no public engine origin resolves — the
 * `engine_public_url_missing` guard (buildOAuthRedirectUri() === null).
 */
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

/**
 * The single entry point that flags a connector as needing re-auth and emits
 * the notification — used by every detector (request dispatch, OAuth refresh
 * worker, proactive scan) so the transaction boundary and the dedup guard live
 * in exactly one place.
 *
 * Wraps the mark + emit in ONE transaction so the state flip and the outbox
 * event commit atomically. The notification (and the reauth-URL resolution) run
 * ONLY on the false→true edge, so a connector hammered N times produces exactly
 * one event. `buildReauthUrl` is pure, so it is safe to call inside the tx.
 */
export async function flagConnectorAuthFailure(
  db: Db,
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
  // After the commit: a connector newly needing a sign-in is an attention
  // entry appearing.
  if (result.transitioned) invalidateTenantState(connector.tenant_id);
  return result;
}
