// Google Chat chat adapter.
//
//   - Inbound verification: JWT signed by chat@system.gserviceaccount.com,
//     audience = bot's google_client_id. Issuer / audience / JWKS URL
//     are all injectable so tests hit a local mock.
//   - Outbound auth: service-account JWT assertion → token endpoint
//     → access_token (cached via GoogleAuth).
//   - Outbound send: POST to `${baseUrl}/v1/spaces/${name}/messages`.
//   - Approval prompt: Card v2 with a buttonList of two buttons.

import { createRemoteJWKSet, jwtVerify } from "jose";
import { logger } from "../../logging/logger.ts";
import type { ChatAdapter } from "../adapter.ts";
import type { ApprovalCard, ChatDelivery, ChatEvent, VerifiedEvent } from "../types.ts";
import { GoogleAuth, type GoogleAuthOptions } from "./auth.ts";

export interface GoogleChatAdapterOptions extends GoogleAuthOptions {
  /** Base URL of the Google Chat REST API. */
  baseUrl: string;
  /** Injectable inbound JWKS URL. */
  jwksUrl?: string;
  /** Expected inbound issuer. Defaults to chat@system.gserviceaccount.com. */
  issuer?: string;
  /** Expected inbound audience (bot client id). */
  audience?: string;
}

export class GoogleChatAdapter implements ChatAdapter {
  readonly platform = "google_chat" as const;
  private readonly auth: GoogleAuth;
  private readonly opts: GoogleChatAdapterOptions;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null;

  constructor(opts: GoogleChatAdapterOptions) {
    this.opts = opts;
    this.auth = new GoogleAuth(opts);
    this.jwks = opts.jwksUrl ? createRemoteJWKSet(new URL(opts.jwksUrl)) : null;
  }

  async verify(req: Request): Promise<VerifiedEvent | null> {
    const body = await req.text();
    const authz = req.headers.get("authorization") ?? "";
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      logger.warn({
        module: "chat",
        action: "verify.rejected",
        msg: "google chat request missing Bearer authorization header",
        platform: "google_chat",
        reason: "missing_bearer",
      });
      return null;
    }
    if (!this.jwks) {
      try {
        return { platform: "google_chat", raw: JSON.parse(body) };
      } catch {
        return null;
      }
    }
    try {
      const verifyOpts: { issuer?: string; audience?: string } = {};
      verifyOpts.issuer = this.opts.issuer ?? "chat@system.gserviceaccount.com";
      if (this.opts.audience) verifyOpts.audience = this.opts.audience;
      await jwtVerify(m[1] ?? "", this.jwks, verifyOpts);
      return { platform: "google_chat", raw: JSON.parse(body) };
    } catch (err) {
      logger.warn({
        module: "chat",
        action: "verify.rejected",
        msg: "google chat jwt verification failed",
        platform: "google_chat",
        reason: "jwt_invalid",
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async receive(ev: VerifiedEvent): Promise<ChatEvent> {
    const raw = ev.raw as Record<string, unknown>;
    const space = (raw.space as Record<string, unknown>) ?? {};
    const user = (raw.user as Record<string, unknown>) ?? {};
    const message = (raw.message as Record<string, unknown>) ?? {};
    const thread = (message.thread as Record<string, unknown>) ?? {};
    const text = typeof message.text === "string" ? message.text : "";

    // Session keying: `message.thread.name` is populated on EVERY
    // Google Chat message (each message formally belongs to a thread),
    // so keying on its presence would fragment a space into one
    // conversation per message. The documented discriminator is
    // `message.threadReply` (output-only boolean; proto3 JSON omits
    // false — treat absent as false): only a genuine reply INSIDE a
    // thread carries it. Top-level messages and DMs therefore map to
    // the dispatcher's `${space}:root` fallback — one persistent
    // conversation per space (topic memory) — while real thread
    // replies get their own thread-scoped conversation. Applies
    // uniformly to SPACE, GROUP_CHAT, and DIRECT_MESSAGE (DMs are
    // inline-threaded too).
    const threadId =
      message.threadReply === true && typeof thread.name === "string" ? thread.name : undefined;

    // Replay dedup: Google retries deliveries best-effort on timeout /
    // non-2xx, so every ingested event needs a stable key. A MESSAGE is
    // uniquely `message.name`; a CARD_CLICKED reuses the card message's
    // name across DIFFERENT legitimate clicks, so the delivery
    // `eventTime` disambiguates (a retry replays the same eventTime).
    const messageName = typeof message.name === "string" ? message.name : "";
    const eventTime = typeof raw.eventTime === "string" ? raw.eventTime : "";
    const eventKey =
      raw.type === "MESSAGE" && messageName
        ? messageName
        : messageName || eventTime
          ? `${String(raw.type ?? "unknown")}:${eventTime}:${messageName || ((space.name as string) ?? "")}`
          : undefined;

    if (raw.type === "CARD_CLICKED") {
      // cardsV2 clicks deliver the action through `event.common`:
      // `common.invokedFunction` (the onClick.action.function name) and
      // `common.parameters` as a FLATTENED string:string map. The
      // legacy cards-v1 shape (`event.action.actionMethodName` +
      // `action.parameters` as a {key,value} LIST) is still present on
      // some payloads — keep it as the fallback.
      const common = (raw.common as Record<string, unknown>) ?? {};
      const commonParams =
        common.parameters && typeof common.parameters === "object"
          ? (common.parameters as Record<string, unknown>)
          : {};
      const action = (raw.action as Record<string, unknown>) ?? {};
      const legacyParams = (action.parameters as Array<Record<string, unknown>>) ?? [];
      const legacyParam = (key: string): string =>
        (legacyParams.find((p) => p.key === key)?.value as string) ?? "";
      const actionId =
        typeof commonParams.action_id === "string" && commonParams.action_id.length > 0
          ? commonParams.action_id
          : legacyParam("action_id");
      const valueParam =
        typeof commonParams.value === "string" && commonParams.value.length > 0
          ? commonParams.value
          : legacyParam("value");
      return {
        platform: "google_chat",
        workspace_id: (space.name as string) ?? "",
        channel_id: (space.name as string) ?? "",
        ...(threadId ? { thread_id: threadId } : {}),
        user_id: (user.name as string) ?? "",
        kind: "interaction",
        interaction: { action_id: actionId, value: valueParam },
        ...(eventKey ? { event_key: eventKey } : {}),
        raw: ev.raw,
      };
    }

    // Every non-MESSAGE, non-CARD_CLICKED event type is a system event
    // the dispatcher must ack-and-ignore instead of running a turn on —
    // the live EventType enum also carries ADDED_TO_SPACE,
    // REMOVED_FROM_SPACE, APP_COMMAND, WIDGET_UPDATED, APP_HOME,
    // SUBMIT_FORM, and Google adds more without notice.
    // REMOVED_FROM_SPACE is normalized so the dispatcher can drop the
    // space's session bindings.
    if (raw.type !== "MESSAGE") {
      const systemEvent =
        raw.type === "REMOVED_FROM_SPACE"
          ? "removed_from_space"
          : raw.type === "ADDED_TO_SPACE"
            ? "added_to_space"
            : String(raw.type ?? "unknown");
      return {
        platform: "google_chat",
        workspace_id: (space.name as string) ?? "",
        channel_id: (space.name as string) ?? "",
        user_id: (user.name as string) ?? "",
        kind: "system",
        system_event: systemEvent,
        ...(eventKey ? { event_key: eventKey } : {}),
        raw: ev.raw,
      };
    }

    return {
      platform: "google_chat",
      workspace_id: (space.name as string) ?? "",
      channel_id: (space.name as string) ?? "",
      ...(threadId ? { thread_id: threadId } : {}),
      user_id: (user.name as string) ?? "",
      kind: text.startsWith("/") ? "slash_command" : "mention",
      text,
      ...(eventKey ? { event_key: eventKey } : {}),
      raw: ev.raw,
    };
  }

  /**
   * Messages path for a space. `channel_id` carries the full Google
   * resource name (`spaces/<id>`, from `space.name` in `receive()`);
   * accept a bare id too. Resource names are plain path segments — no
   * URL-encoding (encoding the embedded `/` breaks the route).
   */
  private messagesPath(channelId: string): string {
    const name = channelId.startsWith("spaces/") ? channelId : `spaces/${channelId}`;
    return `/v1/${name}/messages`;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const token = await this.auth.getAccessToken();
    const f = this.opts.fetchImpl ?? fetch;
    return f(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async send(delivery: ChatDelivery): Promise<{ platform_message_id: string }> {
    // A thread reply REQUIRES the `messageReplyOption` query parameter:
    // with the default (UNSPECIFIED) the API silently ignores any
    // thread in the body and starts a NEW thread — which would fork the
    // thread-keyed conversation without anyone noticing. OR_FAIL makes
    // the miss loud (404) so we can degrade deliberately to a top-level
    // message (covers DM threads, where in-thread replies are
    // undocumented API surface).
    const threadName = delivery.thread_id
      ? delivery.thread_id.startsWith("spaces/")
        ? delivery.thread_id
        : `${delivery.channel_id}/threads/${delivery.thread_id}`
      : null;
    const basePath = this.messagesPath(delivery.channel_id);
    if (threadName) {
      const res = await this.post(`${basePath}?messageReplyOption=REPLY_MESSAGE_OR_FAIL`, {
        text: delivery.text ?? "",
        thread: { name: threadName },
      });
      if (res.ok) {
        const json = (await res.json()) as { name?: string };
        return { platform_message_id: json.name ?? "" };
      }
      if (res.status !== 404) throw new Error(`google_chat send failed: ${res.status}`);
      // Thread not addressable (e.g. DM thread) — fall through to a
      // top-level send so the reply is never dropped.
    }
    const res = await this.post(basePath, { text: delivery.text ?? "" });
    if (!res.ok) throw new Error(`google_chat send failed: ${res.status}`);
    const json = (await res.json()) as { name?: string };
    return { platform_message_id: json.name ?? "" };
  }

  async update(delivery: ChatDelivery, platform_message_id: string): Promise<void> {
    const token = await this.auth.getAccessToken();
    const f = this.opts.fetchImpl ?? fetch;
    // `updateMask` is REQUIRED — without it the API rejects the update.
    // PATCH is the documented preference over PUT.
    const res = await f(
      `${this.opts.baseUrl.replace(/\/$/, "")}/v1/${platform_message_id
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?updateMask=text`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: delivery.text ?? "" }),
      },
    );
    if (!res.ok) throw new Error(`google_chat update failed: ${res.status}`);
  }

  async sendApproval(card: ApprovalCard): Promise<{ platform_message_id: string }> {
    const cardV2 = {
      cardsV2: [
        {
          cardId: `subkit_approval_${card.approval_id}`,
          card: {
            header: { title: card.summary },
            sections: [
              ...(card.body ? [{ widgets: [{ textParagraph: { text: card.body } }] }] : []),
              {
                widgets: [
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: "Approve",
                          onClick: {
                            action: {
                              function: "approve",
                              parameters: [
                                { key: "action_id", value: `approve:${card.approval_id}` },
                                { key: "value", value: card.conversation_id },
                              ],
                            },
                          },
                        },
                        {
                          text: "Reject",
                          onClick: {
                            action: {
                              function: "reject",
                              parameters: [
                                { key: "action_id", value: `reject:${card.approval_id}` },
                                { key: "value", value: card.conversation_id },
                              ],
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const res = await this.post(this.messagesPath(card.channel_id), cardV2);
    if (!res.ok) throw new Error(`google_chat approval failed: ${res.status}`);
    const json = (await res.json()) as { name?: string };
    return { platform_message_id: json.name ?? "" };
  }
}
