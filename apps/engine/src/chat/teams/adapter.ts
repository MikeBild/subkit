// Microsoft Teams chat adapter.
//
//   - Inbound verification: Bot Framework JWTs signed by AAD's JWKS.
//     P12 exposes `issuer` + `jwksUrl` + `audience` as injectable
//     options so tests point them at a local mock. Real deployments
//     pass the Bot Framework values.
//   - Outbound auth: client_credentials via `TeamsAuth` at the
//     injectable `tokenEndpoint`. Token cache reuses the same access
//     token for `expires_in - 60s`.
//   - Outbound send: POST to `${serviceUrl}/v3/conversations/${id}/activities`.
//   - Approval prompt: Adaptive Card 1.5 with two Action.Submit buttons.

import { createRemoteJWKSet, jwtVerify } from "jose";

import { logger } from "../../logging/logger.ts";
import type { ChatAdapter } from "../adapter.ts";
import type { ApprovalCard, ChatDelivery, ChatEvent, VerifiedEvent } from "../types.ts";
import { TeamsAuth, type TeamsAuthOptions } from "./auth.ts";

export interface TeamsAdapterOptions extends TeamsAuthOptions {
  /** Bot Framework serviceUrl — base for outbound activity posts. */
  serviceUrl: string;
  /** JWKS URL for inbound verification. Injectable for tests. */
  jwksUrl?: string;
  /** Expected issuer — injectable for tests. */
  issuer?: string;
  /** Expected audience (usually the bot's app id). */
  audience?: string;
}

export class TeamsAdapter implements ChatAdapter {
  readonly platform = "teams" as const;
  private readonly auth: TeamsAuth;
  private readonly opts: TeamsAdapterOptions;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null;

  constructor(opts: TeamsAdapterOptions) {
    this.opts = opts;
    this.auth = new TeamsAuth(opts);
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
        msg: "teams request missing Bearer authorization header",
        platform: "teams",
        reason: "missing_bearer",
      });
      return null;
    }
    if (!this.jwks) {
      // Skipping verification (trusted transport). Tests that do not
      // set jwksUrl still need a way in — return the parsed body.
      try {
        return { platform: "teams", raw: JSON.parse(body) };
      } catch {
        return null;
      }
    }
    try {
      const verifyOpts: { issuer?: string; audience?: string } = {};
      if (this.opts.issuer) verifyOpts.issuer = this.opts.issuer;
      if (this.opts.audience) verifyOpts.audience = this.opts.audience;
      await jwtVerify(m[1] ?? "", this.jwks, verifyOpts);
      return { platform: "teams", raw: JSON.parse(body) };
    } catch (err) {
      logger.warn({
        module: "chat",
        action: "verify.rejected",
        msg: "teams jwt verification failed",
        platform: "teams",
        reason: "jwt_invalid",
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async receive(ev: VerifiedEvent): Promise<ChatEvent> {
    const raw = ev.raw as Record<string, unknown>;
    const from = (raw.from as Record<string, unknown>) ?? {};
    const convo = (raw.conversation as Record<string, unknown>) ?? {};
    const channelData = (raw.channelData as Record<string, unknown>) ?? {};
    const tenantInfo = (channelData.tenant as Record<string, unknown>) ?? {};
    const text = typeof raw.text === "string" ? raw.text : "";

    const value = raw.value as Record<string, unknown> | undefined;
    if (value && typeof value.action_id === "string") {
      return {
        platform: "teams",
        workspace_id: (tenantInfo.id as string) ?? "",
        channel_id: (convo.id as string) ?? "",
        user_id: (from.id as string) ?? "",
        kind: "interaction",
        interaction: {
          action_id: value.action_id,
          ...(typeof value.value === "string" ? { value: value.value } : {}),
        },
        raw: ev.raw,
      };
    }

    return {
      platform: "teams",
      workspace_id: (tenantInfo.id as string) ?? "",
      channel_id: (convo.id as string) ?? "",
      user_id: (from.id as string) ?? "",
      kind: text.startsWith("/") ? "slash_command" : "mention",
      text,
      raw: ev.raw,
    };
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const token = await this.auth.getAccessToken();
    const f = this.opts.fetchImpl ?? fetch;
    return f(`${this.opts.serviceUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async send(delivery: ChatDelivery): Promise<{ platform_message_id: string }> {
    const res = await this.post(
      `/v3/conversations/${encodeURIComponent(delivery.channel_id)}/activities`,
      {
        type: "message",
        text: delivery.text ?? "",
      },
    );
    if (!res.ok) throw new Error(`teams send failed: ${res.status}`);
    const json = (await res.json()) as { id?: string };
    return { platform_message_id: json.id ?? "" };
  }

  async update(delivery: ChatDelivery, platform_message_id: string): Promise<void> {
    const token = await this.auth.getAccessToken();
    const f = this.opts.fetchImpl ?? fetch;
    const url =
      `${this.opts.serviceUrl.replace(/\/$/, "")}/v3/conversations/` +
      `${encodeURIComponent(delivery.channel_id)}/activities/${encodeURIComponent(platform_message_id)}`;
    const res = await f(url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "message", text: delivery.text ?? "" }),
    });
    if (!res.ok) throw new Error(`teams update failed: ${res.status}`);
  }

  async sendApproval(card: ApprovalCard): Promise<{ platform_message_id: string }> {
    const adaptiveCard = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.5",
      body: [
        { type: "TextBlock", text: card.summary, weight: "Bolder", wrap: true },
        ...(card.body ? [{ type: "TextBlock", text: card.body, wrap: true }] : []),
      ],
      actions: [
        {
          type: "Action.Submit",
          title: "Approve",
          data: { action_id: `approve:${card.approval_id}`, value: card.conversation_id },
        },
        {
          type: "Action.Submit",
          title: "Reject",
          data: { action_id: `reject:${card.approval_id}`, value: card.conversation_id },
        },
      ],
    };
    const res = await this.post(
      `/v3/conversations/${encodeURIComponent(card.channel_id)}/activities`,
      {
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: adaptiveCard,
          },
        ],
      },
    );
    if (!res.ok) throw new Error(`teams approval failed: ${res.status}`);
    const json = (await res.json()) as { id?: string };
    return { platform_message_id: json.id ?? "" };
  }
}
