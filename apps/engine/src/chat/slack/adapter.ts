// Slack chat adapter.
//
//   - Inbound verification via v0 HMAC-SHA256 over "v0:${ts}:${body}".
//   - Inbound normalization for Events API (app_mention), slash
//     commands (application/x-www-form-urlencoded) and block action
//     interactions (payload=<urlencoded json>).
//   - Outbound via `@slack/web-api`'s WebClient. Tests construct the
//     adapter with { slackApiUrl: "<mock>/" } so all outbound HTTP
//     calls land on a local Hono server.

import { WebClient } from "@slack/web-api";
import type { ChatAdapter } from "../adapter.ts";
import type {
  ApprovalCard,
  ChatDelivery,
  ChatEvent,
  ChatInteractionAction,
  VerifiedEvent,
} from "../types.ts";
import { renderApprovalBlocks, renderMessageBlocks } from "./block-kit.ts";
import { verifySlackRequest } from "./verifier.ts";

export interface SlackAdapterOptions {
  signingSecret: string;
  botToken: string;
  /** Override for tests (points at a local mock Slack API). */
  slackApiUrl?: string;
  /** Tolerance for HMAC timestamp checks. Defaults to 5 minutes. */
  maxSkewSeconds?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export class SlackAdapter implements ChatAdapter {
  readonly platform = "slack" as const;
  private readonly client: WebClient;
  private readonly opts: SlackAdapterOptions;

  constructor(opts: SlackAdapterOptions) {
    this.opts = opts;
    this.client = new WebClient(opts.botToken, {
      ...(opts.slackApiUrl ? { slackApiUrl: opts.slackApiUrl } : {}),
    });
  }

  async verify(req: Request): Promise<VerifiedEvent | null> {
    const body = await req.text();
    const result = verifySlackRequest(
      {
        timestamp: req.headers.get("x-slack-request-timestamp"),
        signature: req.headers.get("x-slack-signature"),
        body,
      },
      {
        signingSecret: this.opts.signingSecret,
        ...(this.opts.maxSkewSeconds !== undefined
          ? { maxSkewSeconds: this.opts.maxSkewSeconds }
          : {}),
        ...(this.opts.now ? { now: this.opts.now } : {}),
      },
    );
    if (!result.ok) return null;

    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return { platform: "slack", raw: JSON.parse(body) };
    }
    // Form-encoded (slash commands, interactions).
    const params = new URLSearchParams(body);
    if (params.has("payload")) {
      return { platform: "slack", raw: JSON.parse(params.get("payload") ?? "{}") };
    }
    const form: Record<string, string> = {};
    params.forEach((value, key) => {
      form[key] = value;
    });
    return { platform: "slack", raw: { __slack_form: true, ...form } };
  }

  async receive(ev: VerifiedEvent): Promise<ChatEvent> {
    const raw = ev.raw as Record<string, unknown>;

    // Events API (app_mention).
    if (raw.type === "event_callback") {
      const inner = raw.event as Record<string, unknown> | undefined;
      if (inner && inner.type === "app_mention") {
        return {
          platform: "slack",
          workspace_id: (raw.team_id as string) ?? "",
          channel_id: (inner.channel as string) ?? "",
          thread_id: (inner.thread_ts as string) ?? (inner.ts as string) ?? undefined,
          user_id: (inner.user as string) ?? "",
          kind: "mention",
          text: (inner.text as string) ?? "",
          raw: ev.raw,
        };
      }
    }

    // Block Kit interaction payload.
    if (raw.type === "block_actions") {
      const actions = (raw.actions as Array<Record<string, unknown>>) ?? [];
      const a = actions[0] ?? {};
      const interaction: ChatInteractionAction = {
        action_id: (a.action_id as string) ?? "",
        ...(typeof a.value === "string" ? { value: a.value } : {}),
      };
      const channel = (raw.channel as Record<string, unknown>) ?? {};
      const user = (raw.user as Record<string, unknown>) ?? {};
      const team = (raw.team as Record<string, unknown>) ?? {};
      const msg = (raw.message as Record<string, unknown>) ?? {};
      return {
        platform: "slack",
        workspace_id: (team.id as string) ?? (raw.team_id as string) ?? "",
        channel_id: (channel.id as string) ?? "",
        thread_id: (msg.thread_ts as string) ?? (msg.ts as string) ?? undefined,
        user_id: (user.id as string) ?? "",
        kind: "interaction",
        interaction,
        raw: ev.raw,
      };
    }

    // Slash command (form post).
    if ((raw as Record<string, unknown>).__slack_form === true) {
      const form = raw as Record<string, string>;
      return {
        platform: "slack",
        workspace_id: form.team_id ?? "",
        channel_id: form.channel_id ?? "",
        user_id: form.user_id ?? "",
        kind: "slash_command",
        text: `${form.command ?? ""} ${form.text ?? ""}`.trim(),
        raw: ev.raw,
      };
    }

    throw new Error(`slack: unrecognized event shape`);
  }

  async send(delivery: ChatDelivery): Promise<{ platform_message_id: string }> {
    const blocks = renderMessageBlocks(delivery);
    if (delivery.kind === "ephemeral") {
      const res = await this.client.chat.postEphemeral({
        channel: delivery.channel_id,
        user: delivery.thread_id ?? "",
        text: delivery.text ?? "",
        blocks,
      });
      return { platform_message_id: (res.message_ts as string) ?? "" };
    }
    const res = await this.client.chat.postMessage({
      channel: delivery.channel_id,
      ...(delivery.thread_id ? { thread_ts: delivery.thread_id } : {}),
      text: delivery.text ?? "",
      blocks,
    });
    return { platform_message_id: (res.ts as string) ?? "" };
  }

  async update(delivery: ChatDelivery, platform_message_id: string): Promise<void> {
    await this.client.chat.update({
      channel: delivery.channel_id,
      ts: platform_message_id,
      text: delivery.text ?? "",
      blocks: renderMessageBlocks(delivery),
    });
  }

  async sendApproval(card: ApprovalCard): Promise<{ platform_message_id: string }> {
    const res = await this.client.chat.postMessage({
      channel: card.channel_id,
      ...(card.thread_id ? { thread_ts: card.thread_id } : {}),
      text: card.summary,
      blocks: renderApprovalBlocks(card),
    });
    return { platform_message_id: (res.ts as string) ?? "" };
  }
}
