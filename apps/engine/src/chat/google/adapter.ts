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
    if (!m) return null;
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
    } catch {
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

    if (raw.type === "CARD_CLICKED") {
      const action = (raw.action as Record<string, unknown>) ?? {};
      const params = (action.parameters as Array<Record<string, unknown>>) ?? [];
      const actionId = (params.find((p) => p.key === "action_id")?.value as string) ?? "";
      const valueParam = (params.find((p) => p.key === "value")?.value as string) ?? "";
      return {
        platform: "google_chat",
        workspace_id: (space.name as string) ?? "",
        channel_id: (space.name as string) ?? "",
        thread_id: (thread.name as string) ?? undefined,
        user_id: (user.name as string) ?? "",
        kind: "interaction",
        interaction: { action_id: actionId, value: valueParam },
        raw: ev.raw,
      };
    }

    return {
      platform: "google_chat",
      workspace_id: (space.name as string) ?? "",
      channel_id: (space.name as string) ?? "",
      thread_id: (thread.name as string) ?? undefined,
      user_id: (user.name as string) ?? "",
      kind: text.startsWith("/") ? "slash_command" : "mention",
      text,
      raw: ev.raw,
    };
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
    const res = await this.post(`/v1/spaces/${encodeURIComponent(delivery.channel_id)}/messages`, {
      text: delivery.text ?? "",
      ...(delivery.thread_id
        ? { thread: { name: `${delivery.channel_id}/threads/${delivery.thread_id}` } }
        : {}),
    });
    if (!res.ok) throw new Error(`google_chat send failed: ${res.status}`);
    const json = (await res.json()) as { name?: string };
    return { platform_message_id: json.name ?? "" };
  }

  async update(delivery: ChatDelivery, platform_message_id: string): Promise<void> {
    const token = await this.auth.getAccessToken();
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(
      `${this.opts.baseUrl.replace(/\/$/, "")}/v1/${encodeURIComponent(platform_message_id)}`,
      {
        method: "PUT",
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
    const res = await this.post(
      `/v1/spaces/${encodeURIComponent(card.channel_id)}/messages`,
      cardV2,
    );
    if (!res.ok) throw new Error(`google_chat approval failed: ${res.status}`);
    const json = (await res.json()) as { name?: string };
    return { platform_message_id: json.name ?? "" };
  }
}
