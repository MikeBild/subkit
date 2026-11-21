import { markConnectorNativeUrlElicitationsComplete } from "../../../conversations/public/elicitation.ts";
import type { Db } from "../../../db/client.ts";
import { writeEvent } from "../../../db/events.ts";
import { logger } from "../../../logging/index.ts";
import {
  ConnectorOauthCallbackFailedPayloadSchema,
  type ConnectorOauthCallbackFailedReasons,
  ConnectorOauthCallbackPayloadSchema,
  ConnectorSignInFinishedPayloadSchema,
} from "../../../pubsub/index.ts";

export type SignInFailedReason = (typeof ConnectorOauthCallbackFailedReasons)[number];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function signalSignInFinished(
  db: Db,
  p: {
    module: string;
    tenant_id: string;
    connector_id: string;
    connector_slug: string | null;
    reason: SignInFailedReason | null;
  },
  outcome: "succeeded" | "failed",
): Promise<void> {
  try {
    const payload = ConnectorSignInFinishedPayloadSchema.parse({
      connector_id: p.connector_id,
      connector_slug: p.connector_slug,
      outcome,
      reason: outcome === "failed" ? p.reason : null,
    });
    await writeEvent(db, {
      tenant_id: p.tenant_id,
      channel: "connector.oauth",
      type: "connector.oauth.signin_finished",
      payload,
    });
  } catch (err) {
    logger.warn({
      module: p.module,
      action: "callback.finished_event_publish_failed",
      msg: "the sign-in ended but the signin_finished event could not be written; a waiting window will not hear about it",
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      outcome,
      error: errorText(err),
    });
  }
}

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
  await signalSignInFinished(db, { ...p, reason: null }, "succeeded");
}

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
  await signalSignInFinished(db, p, "failed");
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
