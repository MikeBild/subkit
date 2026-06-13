// Wait for an OAuth2 authorization-code dance to complete.
//
// After the engine hands the operator an authorization URL, the actual
// token exchange happens out-of-band: the operator authorizes in their
// browser, the provider redirects to `/v1/oauth/callback`, and the
// callback route writes a `credentials` row + publishes a
// `connector.oauth.callback_succeeded` event.
//
// `waitForOAuthCredential` bridges that gap inside a single tool call.
// It resolves on three signals, whichever fires first:
//
//   1. `succeeded` — the credential lands. Detected via the
//      `connector.oauth` pubsub channel (`callback_succeeded` event,
//      re-verified by a credential re-read) OR a ~1.5s DB poll of the
//      `credentials` table (covers a missed event — listener
//      reconnecting, etc).
//   2. `failed` — an explicit `connector.oauth.callback_failed` event.
//      The callback route DELETEs the `connector_oauth_states` row at
//      the START of a seconds-long token exchange, so "the state row is
//      gone" can NOT be used to infer failure — it is true for the
//      entire exchange window. Failure is therefore signalled ONLY by
//      this explicit event.
//   3. `timeout` — the upper bound elapsed with no other signal.
//
// Bounded by `timeout_ms`. Idempotent: calling it again after the
// credential already exists returns `succeeded` immediately, so the
// DB-pause OAuth resume path can re-drive the tool safely.

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { credentials } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { getListener } from "../../pubsub/listener.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import {
  ConnectorOauthCallbackFailedPayloadSchema,
  ConnectorOauthCallbackPayloadSchema,
} from "../../pubsub/types.ts";

export type OAuthWaitStatus = "succeeded" | "failed" | "timeout";

export interface WaitForOAuthCredentialInput {
  tenant_id: string;
  connector_id: string;
  environment: "dev" | "prod";
  /** Upper bound in ms. Defaults to 45s — see `OAUTH_WAIT_CEILING_MS`. */
  timeout_ms?: number;
  db: Db;
  /** Test-only listener injection; production uses the engine-global listener. */
  listener?: {
    on: <P = unknown>(
      channel: "connector.oauth",
      handler: (event: EventEnvelope<P>) => void,
    ) => void;
    off: <P = unknown>(
      channel: "connector.oauth",
      handler: (event: EventEnvelope<P>) => void,
    ) => void;
  };
}

// Upper bound for an OAuth wait — also the budget ceiling for callers
// that share the client's tool-call timeout with a prior round-trip
// (e.g. `authenticate_oauth` issues an MCP `elicitation/create` bridge
// call BEFORE the wait; it subtracts the elapsed bridge cost from this
// value and clamps to `OAUTH_WAIT_MIN_FLOOR_MS` so the wait still does
// at least a couple of DB-poll ticks even when the elicitation
// round-trip was slow).
//
// Kept safely under the smallest known MCP client tool-call timeout
// (~60s for claude.ai / Cursor). A tool call that out-runs the client's
// timeout is killed mid-flight; resolving `timeout` ourselves first lets
// the tool return a structured "still pending, re-run authenticate_oauth"
// result the agent can act on, instead of an opaque transport error.
export const OAUTH_WAIT_CEILING_MS = 45_000;
export const OAUTH_WAIT_MIN_FLOOR_MS = 5_000;
// DB-poll cadence for the `credentials`-row fallback. Exported so tests
// can derive their timeout budgets from the same cadence the wait uses
// — a test that needs "at least N poll ticks" can compute the budget
// instead of hardcoding a number that silently desyncs if this changes.
export const POLL_INTERVAL_MS = 1_500;

/** Is there a non-deleted credential row for (tenant, connector, env)? */
async function credentialExists(
  db: Db,
  tenant_id: string,
  connector_id: string,
  environment: "dev" | "prod",
): Promise<boolean> {
  const rows = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.connector_id, connector_id),
        eq(credentials.environment, environment),
        isNull(credentials.deleted_at),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export function waitForOAuthCredential(p: WaitForOAuthCredentialInput): Promise<OAuthWaitStatus> {
  const timeoutMs = p.timeout_ms ?? OAUTH_WAIT_CEILING_MS;

  return new Promise<OAuthWaitStatus>((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let subscribedListener: WaitForOAuthCredentialInput["listener"] | null = null;

    // The listener has no per-tenant channel — we subscribe to the
    // global `connector.oauth` channel and filter every event in the
    // handler by `tenant_id` + `connector_id` before acting on it.
    const handler = (event: EventEnvelope): void => {
      if (settled) return;
      if (event.tenant_id !== p.tenant_id) return;
      if (event.type === "connector.oauth.callback_succeeded") {
        const parsed = ConnectorOauthCallbackPayloadSchema.safeParse(event.payload);
        if (!parsed.success) return;
        if (parsed.data.connector_id !== p.connector_id) return;
        // Re-read the credential row before concluding `succeeded`: the
        // event may land before the `credentials` row is visible to
        // this connection (write-ordering race). If the re-read is
        // false, ignore the event and let the DB poll catch up.
        void (async () => {
          if (settled) return;
          try {
            // The `settled` check above can be stale by the time this
            // await resolves — the DB poll or timeout may have settled
            // concurrently. That is safe: `finish()` has its own
            // `settled` guard and is idempotent, so a late re-read that
            // calls `finish` after another path already did is a no-op.
            // `finish` is therefore never effectively called twice.
            if (await credentialExists(p.db, p.tenant_id, p.connector_id, p.environment)) {
              finish("succeeded");
            }
          } catch {
            /* poll still covers it */
          }
        })();
        return;
      }
      if (event.type === "connector.oauth.callback_failed") {
        const parsed = ConnectorOauthCallbackFailedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) return;
        if (parsed.data.connector_id !== p.connector_id) return;
        finish("failed");
      }
    };

    const cleanup = (): void => {
      try {
        subscribedListener?.off("connector.oauth", handler);
      } catch {
        /* listener may not be running in tests — ignore */
      }
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      pollTimer = null;
      timeoutTimer = null;
    };

    const finish = (status: OAuthWaitStatus): void => {
      if (settled) return;
      settled = true;
      cleanup();
      logger.info({
        module: "oauth",
        action: "oauth.wait.resolved",
        msg: "waitForOAuthCredential resolved",
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        environment: p.environment,
        status,
      });
      resolve(status);
    };

    // 1 + 2. pubsub — fastest signal. Registered FIRST, before the
    // idempotency `credentialExists` query below, so a `callback_*`
    // event landing during that async query is not missed. Registering
    // after the query left a blind window: the failure path has no
    // DB-poll fallback (`callback_failed` is detectable ONLY via the
    // event), so an event missed there meant a guaranteed full timeout.
    // Tolerate a missing listener (tests), but surface it: in production
    // a missing listener means the `callback_failed` event can never
    // resolve the wait early, so a misconfigured prod listener must not
    // stay invisible.
    try {
      subscribedListener = p.listener ?? getListener();
      subscribedListener.on("connector.oauth", handler);
    } catch (err) {
      logger.warn({
        module: "oauth",
        action: "oauth.wait.listener_unavailable",
        msg: "pubsub listener unavailable — OAuth wait falls back to DB poll only; callback_failed cannot resolve early",
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 1. DB poll fallback — covers a missed `callback_succeeded` event.
    pollTimer = setInterval(() => {
      void (async () => {
        if (settled) return;
        try {
          if (await credentialExists(p.db, p.tenant_id, p.connector_id, p.environment)) {
            finish("succeeded");
          }
        } catch (err) {
          // Poll is best-effort; a transient DB error must not settle
          // the wait early. The timeout still bounds the loop.
          logger.debug({
            module: "oauth",
            action: "oauth.wait.poll_failed",
            msg: "waitForOAuthCredential poll tick failed; will retry",
            tenant_id: p.tenant_id,
            connector_id: p.connector_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();

    // 3. Upper bound. Each call holds one connection open for up to
    // `timeoutMs`.
    timeoutTimer = setTimeout(() => finish("timeout"), timeoutMs);
    timeoutTimer.unref?.();

    // Idempotency — resolve immediately if the credential already
    // exists (covers the DB-pause OAuth resume re-driving the tool).
    // Runs AFTER the listener is registered above, so a `callback_*`
    // event arriving during this async query is still caught.
    void (async () => {
      if (settled) return;
      try {
        if (await credentialExists(p.db, p.tenant_id, p.connector_id, p.environment)) {
          finish("succeeded");
        }
      } catch {
        /* best-effort — the DB poll and timeout still bound the wait */
      }
    })();
  });
}
