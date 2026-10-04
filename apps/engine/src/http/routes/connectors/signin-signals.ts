// What a browser sign-in tells the rest of the product when it comes back.
//
// Both sign-in callbacks — the connector OAuth callback and the MCP
// authorization callback — end the same wait: a conversation paused on a
// re-sign-in link for this connector (an MCP-surface URL elicitation) and a
// terminal tailing `connector.oauth` for the outcome (`sk` auto-resume, the
// install flow). Both are keyed by the connector, not by the route the
// browser went through, so one sign-in route that skipped them would leave
// those waiters to time out on a sign-in that already succeeded.
//
// Best-effort by design: the credential is stored (or the failure recorded)
// before these run, and the page the person reads must not depend on them.
// A failure here is logged, never thrown.

import { markConnectorNativeUrlElicitationsComplete } from "../../../conversations/index.ts";
import type { Db } from "../../../db/client.ts";
import { writeEvent } from "../../../db/events.ts";
import { logger } from "../../../logging/index.ts";
import {
  ConnectorOauthCallbackFailedPayloadSchema,
  type ConnectorOauthCallbackFailedReasons,
  ConnectorOauthCallbackPayloadSchema,
} from "../../../pubsub/index.ts";

export type SignInFailedReason = (typeof ConnectorOauthCallbackFailedReasons)[number];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A credential from a browser sign-in is stored: settle the waiters. */
export async function signalSignInSucceeded(
  db: Db,
  p: {
    module: string;
    tenant_id: string;
    connector_id: string;
    connector_slug: string;
    has_refresh_token: boolean;
  },
): Promise<void> {
  try {
    await markConnectorNativeUrlElicitationsComplete(
      { tenant_id: p.tenant_id, connector_id: p.connector_id, outcome: "succeeded" },
      db,
    );
  } catch (err) {
    logger.warn({
      module: p.module,
      action: "callback.elicitation_completion_failed",
      msg: "credential saved but native MCP URL completion could not be recorded",
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      error: errorText(err),
    });
  }
  try {
    const payload = ConnectorOauthCallbackPayloadSchema.parse({
      connector_id: p.connector_id,
      connector_slug: p.connector_slug,
      has_refresh_token: p.has_refresh_token,
      source: "oauth_callback",
    });
    await writeEvent(db, {
      tenant_id: p.tenant_id,
      channel: "connector.oauth",
      type: "connector.oauth.callback_succeeded",
      payload,
    });
  } catch (err) {
    logger.warn({
      module: p.module,
      action: "callback.event_publish_failed",
      msg: "credential persisted but the callback_succeeded event could not be written; a waiting terminal will not auto-resume this round",
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      error: errorText(err),
    });
  }
}

/**
 * A browser sign-in came back without a credential: settle the waiters.
 * `reason` is a sanitized token from the published allowlist — never a
 * provider's or an exception's own text. A failure the published event has
 * no reason for (null) still settles the paused conversation; a terminal
 * waiting on the event then times out.
 */
export async function signalSignInFailed(
  db: Db,
  p: {
    module: string;
    tenant_id: string;
    connector_id: string;
    connector_slug: string | null;
    reason: SignInFailedReason | null;
  },
): Promise<void> {
  try {
    await markConnectorNativeUrlElicitationsComplete(
      { tenant_id: p.tenant_id, connector_id: p.connector_id, outcome: "failed" },
      db,
    );
  } catch (err) {
    logger.warn({
      module: p.module,
      action: "callback.failed_elicitation_completion_failed",
      msg: "sign-in failed but native MCP URL completion could not be recorded",
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      error: errorText(err),
    });
  }
  if (!p.reason || !p.connector_slug) return;
  try {
    const payload = ConnectorOauthCallbackFailedPayloadSchema.parse({
      connector_id: p.connector_id,
      connector_slug: p.connector_slug,
      reason: p.reason,
    });
    await writeEvent(db, {
      tenant_id: p.tenant_id,
      channel: "connector.oauth",
      type: "connector.oauth.callback_failed",
      payload,
    });
  } catch (err) {
    logger.warn({
      module: p.module,
      action: "callback.failed_event_publish_failed",
      msg: "sign-in failed but the callback_failed event could not be written; a waiter will time out instead of failing fast",
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      error: errorText(err),
    });
  }
}
