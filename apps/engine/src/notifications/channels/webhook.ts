// Webhook notification channel.
//
// The chat-platform adapters (Slack, Teams, Google Chat) deliver
// notifications by calling a vendor SDK. For tenants that prefer to
// receive completion signals via their own infrastructure — a generic
// HTTP endpoint, an internal queue, an SaaS aggregator — we expose a
// `webhook` channel kind. The adapter implements the same minimal
// `NotificationAdapter` shape the dispatcher expects, so it slots into
// the same rate-limiter + circuit-breaker pipeline as the chat
// platforms.
//
// On send:
//   - POST a JSON body containing the rendered text plus structured
//     event metadata (so the receiver can dispatch on event type
//     without parsing the rendered string).
//   - Honour `Retry-After` on rate-limited responses (429 / 503).
//   - Bounded retries with exponential backoff. Delivery decisions —
//     "rate_limited", "circuit_open", "failed" — happen in the
//     dispatcher and the breaker, not here.
//
// The URL of the receiver lives on `notification_channels.config_url`
// (jsonb-typed) so the channel row can carry the secret without
// requiring a new column-per-adapter. The constructor pulls it from a
// channel row at resolution time.

import type { ChatDelivery } from "../../chat/types.ts";
import { assertEgressAllowedResolved, EgressBlockedError } from "../../connectors/egress-guard.ts";
import { logger } from "../../logging/logger.ts";
import type { NotificationAdapter } from "../service.ts";

/** Default cap on POST attempts including the first try. */
export const WEBHOOK_MAX_ATTEMPTS = 3;

/** Maximum backoff between attempts. Capped so a Retry-After of "1 day"
 *  does not park the request indefinitely — the breaker can decide
 *  whether to keep trying after the cap. */
export const WEBHOOK_BACKOFF_CAP_MS = 30_000;

export interface WebhookAdapterOptions {
  /** Endpoint to POST notifications to. */
  url: string;
  /** Optional shared-secret header for receiver-side authentication. */
  secret?: string;
  /** Override for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests; sleeps between retry attempts. */
  sleepMs?: (ms: number) => Promise<void>;
}

/** Build a webhook adapter from a channel row's config. The adapter
 *  declares `platform = "webhook"` so the dispatcher logs and metrics
 *  attribute deliveries to the right channel kind. */
export class WebhookNotificationAdapter implements NotificationAdapter {
  readonly platform = "webhook" as const;
  private readonly opts: WebhookAdapterOptions;

  constructor(opts: WebhookAdapterOptions) {
    this.opts = opts;
  }

  async send(delivery: ChatDelivery): Promise<{ platform_message_id: string }> {
    // SSRF guard: refuse to deliver to private/loopback/link-local targets.
    try {
      await assertEgressAllowedResolved(new URL(this.opts.url), {
        tenant_id: delivery.tenant_id,
      });
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        logger.warn({
          module: "notifications",
          action: "webhook.send_failed",
          msg: "webhook delivery blocked by egress guard",
          url: this.opts.url,
          last_error: "egress_blocked",
          reason: err.reason,
          host: err.host,
        });
      }
      throw err;
    }
    const body = JSON.stringify({
      tenant_id: delivery.tenant_id,
      workspace_id: delivery.workspace_id,
      channel_id: delivery.channel_id,
      kind: delivery.kind,
      text: delivery.text ?? null,
    });
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const sleep = this.opts.sleepMs ?? defaultSleep;
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-subkit-notification": "1",
        "x-subkit-attempt": String(attempt),
      };
      if (this.opts.secret) {
        headers["x-subkit-secret"] = this.opts.secret;
      }
      let res: Response;
      try {
        res = await fetchImpl(this.opts.url, { method: "POST", headers, body });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === WEBHOOK_MAX_ATTEMPTS) break;
        await sleep(backoffFor(attempt));
        continue;
      }
      if (res.ok) {
        const id =
          res.headers.get("x-message-id") ?? `webhook-${Date.now().toString(36)}-${attempt}`;
        return { platform_message_id: id };
      }
      // Surface 4xx (other than 429) as terminal — the receiver is
      // mis-configured and retrying will not change the outcome.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        lastError = `http_${res.status}`;
        break;
      }
      // 429 / 5xx: retry with Retry-After when present, otherwise
      // exponential backoff. Capped at WEBHOOK_BACKOFF_CAP_MS so a
      // hostile receiver cannot pin a worker.
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      lastError = `http_${res.status}`;
      if (attempt === WEBHOOK_MAX_ATTEMPTS) break;
      const backoff = retryAfter ?? backoffFor(attempt);
      await sleep(Math.min(backoff, WEBHOOK_BACKOFF_CAP_MS));
    }
    logger.warn({
      module: "notifications",
      action: "webhook.send_failed",
      msg: "webhook adapter exhausted retry budget",
      url: this.opts.url,
      last_error: lastError,
    });
    throw new Error(`webhook delivery failed: ${lastError ?? "unknown"}`);
  }
}

function backoffFor(attempt: number): number {
  // 500ms, 2_000ms, 8_000ms, ... capped by the call site.
  return 500 * 4 ** (attempt - 1);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.floor(seconds * 1_000);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
