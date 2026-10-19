import type { ChatDelivery } from "../../chat/types.ts";
import { EgressBlockedError, FETCH_DEADLINE_MS, guardedFetch } from "../../connectors/index.ts";
import type { Executor } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import type { NotificationAdapter } from "../service.ts";

export const WEBHOOK_MAX_ATTEMPTS = 3;

export const WEBHOOK_BACKOFF_CAP_MS = 30_000;

export interface WebhookAdapterOptions {
  exec: Executor;
  url: string;
  secret?: string;
  fetchImpl?: typeof fetch;
  sleepMs?: (ms: number) => Promise<void>;
}

export class WebhookNotificationAdapter implements NotificationAdapter {
  readonly platform = "webhook" as const;
  private readonly opts: WebhookAdapterOptions;

  constructor(opts: WebhookAdapterOptions) {
    this.opts = opts;
  }

  async send(delivery: ChatDelivery): Promise<{ platform_message_id: string }> {
    const body = JSON.stringify({
      tenant_id: delivery.tenant_id,
      workspace_id: delivery.workspace_id,
      channel_id: delivery.channel_id,
      kind: delivery.kind,
      text: delivery.text ?? null,
    });
    const fetchImpl = guardedFetch(
      { tenant_id: delivery.tenant_id, exec: this.opts.exec },
      this.opts.fetchImpl ?? fetch,
    );
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
        res = await fetchImpl(this.opts.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(FETCH_DEADLINE_MS),
          redirect: "manual",
        });
      } catch (err) {
        lastError = err instanceof EgressBlockedError ? "egress_blocked" : "network_error";
        if (err instanceof EgressBlockedError) break;
        if (attempt === WEBHOOK_MAX_ATTEMPTS) break;
        await sleep(backoffFor(attempt));
        continue;
      }
      if (res.ok) {
        const id =
          res.headers.get("x-message-id") ?? `webhook-${Date.now().toString(36)}-${attempt}`;
        return { platform_message_id: id };
      }
      await res.body?.cancel();
      if (res.status >= 300 && res.status < 400) {
        lastError = "redirect_blocked";
        break;
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        lastError = `http_${res.status}`;
        break;
      }
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
      tenant_id: delivery.tenant_id,
      last_error: lastError,
    });
    throw new Error(`webhook delivery failed: ${lastError ?? "unknown"}`);
  }
}

function backoffFor(attempt: number): number {
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
