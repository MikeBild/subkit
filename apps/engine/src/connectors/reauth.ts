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
//
// The false→true transition is the *only* edge that emits a notification — a
// failing connector hammered N times per minute must not produce N
// notification storms. `markConnectorNeedsReauth` enforces that edge atomically
// in SQL (`WHERE needs_reauth = false`) and reports whether it transitioned, so
// the caller emits the event exactly once, inside the same transaction.

import { sql } from "drizzle-orm";
import { buildOAuthRedirectUri, OAUTH_CALLBACK_PATH } from "../credentials/oauth2/redirect-uri.ts";
import type { Db, Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { logger } from "../logging/logger.ts";
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
 * Idempotent reset of the re-auth flag, tenant-scoped. Called on a successful
 * authenticated request — the credential clearly works again, so clear the
 * flag and the failure provenance. Safe to call when the flag is already
 * clear (the UPDATE simply matches nothing meaningful).
 */
export async function clearConnectorReauth(
  db: Executor,
  tenant_id: string,
  connector_id: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE connectors
       SET needs_reauth = false,
           auth_failed_at = NULL,
           auth_failed_reason = NULL
     WHERE id = ${connector_id}
       AND tenant_id = ${tenant_id}
  `);
  logger.debug({
    module: "connectors",
    action: "connector.reauth.cleared",
    msg: "connector reauth flag cleared",
    tenant_id,
    connector_id,
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
 * The payload carries every key the fanout's extractors read:
 *   - `severity: "error"`  → extractSeverity resolves "error"
 *   - `workflow_id`        → extractWorkflowId (null when not workflow-scoped)
 *   - plus connector_id / connector_slug / reason / reauth_url for the
 *     notification body so the operator knows which connector to fix and how.
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
  await writeEvent(tx, {
    tenant_id: ev.tenant_id,
    channel: "notification.emitted",
    type: "connector.auth_failed",
    payload: {
      // Read by webhooks/outbound/fanout.ts:extractSeverity — resolves "error".
      severity: "error",
      // Read by extractWorkflowId — null when the failure is not workflow-scoped.
      workflow_id: ev.workflow_id ?? null,
      connector_id: ev.connector_id,
      connector_slug: ev.connector_slug,
      reason: ev.reason,
      reauth_url: ev.reauth_url,
    },
  });
}

/**
 * Resolve the stable "reconnect here" URL for a connector that needs re-auth.
 *
 * PURE: no DB writes, no token/state minting. It returns a stable link to the
 * connector's canonical reconnect endpoint; the actual OAuth `state` / portal
 * token is minted at click-time by that endpoint. This is deliberate —
 * pre-minting a `state` here would (a) expire (the notification may be acted on
 * minutes/hours later), (b) write an outbox-decoupled row that orphans if the
 * surrounding transaction rolls back, and (c) for static auth there is no
 * persisted token at all, so a pre-baked link would be dead. A stable endpoint
 * link has none of those failure modes.
 *
 *   - `oauth2` → `${origin}/v1/connectors/{id}/oauth/start` (mints fresh PKCE
 *     state + redirects to the provider when invoked).
 *   - basic/bearer/header/query/none → `${origin}/v1/connectors/{id}/credentials`
 *     (the credential-update surface).
 *
 * Returns `reauth_url: null` only when no public engine origin resolves — the
 * `engine_public_url_missing` guard (buildOAuthRedirectUri() === null).
 */
export function buildReauthUrl(connector: Pick<ConnectorView, "id" | "slug" | "auth_type">): {
  method: "oauth2" | "portal_setup";
  reauth_url: string | null;
  instructions: string;
} {
  const method = connector.auth_type === "oauth2" ? "oauth2" : "portal_setup";
  const redirect_uri = buildOAuthRedirectUri();
  if (!redirect_uri) {
    return {
      method,
      reauth_url: null,
      instructions: "Set server.public_base_url on the engine, then re-authenticate the connector.",
    };
  }
  const origin = redirect_uri.slice(0, -OAUTH_CALLBACK_PATH.length);
  if (method === "oauth2") {
    return {
      method,
      reauth_url: `${origin}/v1/connectors/${connector.id}/oauth/start`,
      instructions: `Reconnect '${connector.slug}' via its OAuth re-authorization endpoint (POST it, or use the connector page in the app) to refresh the provider authorization.`,
    };
  }
  return {
    method,
    reauth_url: `${origin}/v1/connectors/${connector.id}/credentials`,
    instructions: `Update the saved credentials for '${connector.slug}' at its credential endpoint (or via the connector page in the app).`,
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
  connector: Pick<ConnectorView, "id" | "tenant_id" | "slug" | "auth_type">,
  opts: { reason: string; workflow_id?: string | null },
): Promise<{ transitioned: boolean }> {
  return db.transaction(async (tx) => {
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
}
