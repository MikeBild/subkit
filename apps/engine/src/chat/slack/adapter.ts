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
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { conversationElicitations } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import type { ChatAdapter } from "../adapter.ts";
import type {
  ApprovalCard,
  ChatAdapterCapabilities,
  ChatDelivery,
  ChatElicitation,
  ChatEvent,
  ChatInteractionAction,
  ElicitationKind,
  VerifiedEvent,
} from "../types.ts";
import {
  buildElicitationModal,
  renderApprovalBlocks,
  renderInlineElicitationBlocks,
  renderMessageBlocks,
  renderOpenFormBlocks,
} from "./block-kit.ts";
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
  /** Slack natively renders all five elicitation kinds: confirm/choice/multi
   *  as inline Block Kit interactive elements, text/form via a modal opened
   *  from an "Antworten" button (sync `views.open` on the click's
   *  `trigger_id`). */
  readonly capabilities: ChatAdapterCapabilities = {
    interactive: ["confirm", "choice", "multi", "text", "form"],
  };
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
    if (!result.ok) {
      logger.warn({
        module: "chat",
        action: "verify.rejected",
        msg: "slack request failed signature verification",
        platform: "slack",
        reason: result.reason,
      });
      return null;
    }

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

    // Events API.
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
          event_key: (raw.event_id as string) ?? undefined,
          raw: ev.raw,
        };
      }

      // Direct message to the bot (IM channel). Slack delivers the
      // bot's own replies through this same event stream, so we MUST
      // suppress bot-echo or we answer ourselves forever. The cheapest
      // correct filters: drop anything carrying `bot_id`, any
      // `subtype` (`bot_message`, `message_changed`, `message_deleted`,
      // …), or originating from a user marked as a bot at the auth
      // layer (`is_bot`/`app_id`). Together these cover every
      // self-emitted shape Slack documents.
      if (
        inner &&
        inner.type === "message" &&
        inner.channel_type === "im" &&
        !inner.bot_id &&
        !inner.subtype &&
        !inner.app_id
      ) {
        return {
          platform: "slack",
          workspace_id: (raw.team_id as string) ?? "",
          channel_id: (inner.channel as string) ?? "",
          // DMs have no `thread_ts`; fall back to `ts` so the dispatcher's
          // `thread_id ?? channel_id:root` maps the whole DM to one
          // conversation 1:1.
          thread_id: (inner.thread_ts as string) ?? (inner.ts as string) ?? undefined,
          user_id: (inner.user as string) ?? "",
          // Normalize to "mention" so the dispatcher takes the same
          // bare-text-as-prompt branch it does for @mentions in
          // channels — DMs need no platform-specific dispatch path.
          kind: "mention",
          text: (inner.text as string) ?? "",
          event_key: (raw.event_id as string) ?? undefined,
          raw: ev.raw,
        };
      }
    }

    // Block Kit interaction payload — either an inline `block_actions`
    // click (resolves an inline elicitation kind directly, or opens a
    // modal) or a `view_submission` (the modal form was submitted).
    if (raw.type === "block_actions" || raw.type === "view_submission") {
      const channel = (raw.channel as Record<string, unknown>) ?? {};
      const user = (raw.user as Record<string, unknown>) ?? {};
      const team = (raw.team as Record<string, unknown>) ?? {};
      const workspace_id = (team.id as string) ?? (raw.team_id as string) ?? "";
      const user_id = (user.id as string) ?? "";

      if (raw.type === "view_submission") {
        const view = (raw.view as Record<string, unknown>) ?? {};
        // Flatten Slack's nested view.state.values shape into a flat
        // `{ field_name: primitive }` dict the dispatcher can pass
        // directly into `respondElicitation`. Slack's shape is:
        //   state.values["field:<name>"]["el:<name>"] = { type, value, selected_*, ... }
        // We map each value object to its primitive answer based on
        // the input type. Adapters elsewhere produce the same flat
        // shape — the dispatcher stays provider-agnostic.
        const state = (view.state as Record<string, unknown>) ?? {};
        const stateValues =
          (state.values as Record<string, Record<string, Record<string, unknown>>>) ?? {};
        const form_values: Record<string, unknown> = {};
        for (const [blockId, elements] of Object.entries(stateValues)) {
          if (!blockId.startsWith("field:")) continue;
          const name = blockId.slice("field:".length);
          const elKey = `el:${name}`;
          const el = elements?.[elKey];
          if (!el) continue;
          form_values[name] = extractInputValue(el);
        }

        const interaction: ChatInteractionAction = {
          action_id: "view_submission",
          ...(typeof view.private_metadata === "string"
            ? { value: view.private_metadata as string }
            : {}),
          form_values,
        };
        return {
          platform: "slack",
          workspace_id,
          channel_id: (channel.id as string) ?? "",
          user_id,
          kind: "interaction",
          interaction,
          event_key: (view.id as string) ?? undefined,
          raw: ev.raw,
        };
      }

      // block_actions
      const actions = (raw.actions as Array<Record<string, unknown>>) ?? [];
      const a = actions[0] ?? {};
      const action_id = (a.action_id as string) ?? "";
      const interaction: ChatInteractionAction = {
        action_id,
        ...(typeof a.value === "string" ? { value: a.value } : {}),
      };
      // For a `multi` submit click, the selected checkboxes live in
      // the message's `state.values` keyed by the checkboxes block_id.
      // Re-encode them into `form_values.values` so the dispatcher can
      // forward a clean `{ values: string[] }` to `respondElicitation`
      // without parsing block payloads.
      const multiMatch = /^elicit:([^:]+):multi:submit$/.exec(action_id);
      if (multiMatch) {
        const state = (raw.state as Record<string, unknown>) ?? {};
        const stateValues =
          (state.values as Record<string, Record<string, Record<string, unknown>>>) ?? {};
        const optsBlockId = `subkit_elicit_opts:${multiMatch[1]}`;
        const optsElementId = `elicit:${multiMatch[1]}:multi:select`;
        const checkboxes = stateValues?.[optsBlockId]?.[optsElementId];
        const selected = (checkboxes?.selected_options as Array<{ value: string }>) ?? [];
        interaction.form_values = { values: selected.map((s) => s.value) };
      }
      const msg = (raw.message as Record<string, unknown>) ?? {};
      return {
        platform: "slack",
        workspace_id,
        channel_id: (channel.id as string) ?? "",
        thread_id: (msg.thread_ts as string) ?? (msg.ts as string) ?? undefined,
        user_id,
        kind: "interaction",
        interaction,
        event_key: (raw.trigger_id as string) ?? undefined,
        raw: ev.raw,
      };
    }

    // Slash command (form post).
    if ((raw as Record<string, unknown>).__slack_form === true) {
      const form = raw as Record<string, string>;
      // No native id for slash; key by (command + text + ts) so a retry
      // of the same submission dedups, but two distinct invocations
      // collide-free.
      const stableKey = `slash:${form.team_id ?? ""}:${form.command ?? ""}:${form.text ?? ""}:${form.trigger_id ?? form.user_id ?? ""}`;
      return {
        platform: "slack",
        workspace_id: form.team_id ?? "",
        channel_id: form.channel_id ?? "",
        user_id: form.user_id ?? "",
        kind: "slash_command",
        text: `${form.command ?? ""} ${form.text ?? ""}`.trim(),
        event_key: stableKey,
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

  async renderElicitation(
    elicitation: ChatElicitation,
    target: { tenant_id: string; workspace_id: string; channel_id: string; thread_id?: string },
  ): Promise<{ platform_message_id: string }> {
    // text / form → post an "Antworten" button; the modal opens on
    // click via `handleSyncInteraction` (`views.open` synchronously
    // within the trigger_id window). The same `chat.postMessage` shape
    // serves every kind — the difference is the block payload.
    const blocks =
      elicitation.kind === "text" || elicitation.kind === "form"
        ? renderOpenFormBlocks(elicitation)
        : renderInlineElicitationBlocks(elicitation);
    if (!blocks) {
      // Defensive: unknown kind. Fall back to a plain message so the
      // user always sees the prompt rather than silence.
      const res = await this.client.chat.postMessage({
        channel: target.channel_id,
        ...(target.thread_id ? { thread_ts: target.thread_id } : {}),
        text: elicitation.summary,
      });
      return { platform_message_id: (res.ts as string) ?? "" };
    }
    const res = await this.client.chat.postMessage({
      channel: target.channel_id,
      ...(target.thread_id ? { thread_ts: target.thread_id } : {}),
      text: elicitation.summary,
      blocks,
    });
    return { platform_message_id: (res.ts as string) ?? "" };
  }

  async handleSyncInteraction(args: { event: ChatEvent; db: Db }): Promise<{ handled: boolean }> {
    const { event, db } = args;
    if (event.kind !== "interaction" || !event.interaction) return { handled: false };
    const action_id = event.interaction.action_id;
    // Only `open_elicit:<elicitation_id>` requires the sync fast path —
    // any other action_id (the elicit:* resolutions, view_submission,
    // approve/reject) is fine to queue.
    const m = /^open_elicit:(.+)$/.exec(action_id);
    if (!m) return { handled: false };
    const elicitation_id = m[1]!;

    const raw = event.raw as Record<string, unknown> | undefined;
    const trigger_id = (raw?.trigger_id as string | undefined) ?? "";
    if (!trigger_id) {
      logger.warn({
        module: "chat",
        action: "slack.open_elicit.no_trigger",
        msg: "open_elicit interaction missing trigger_id — cannot open modal",
        elicitation_id,
      });
      return { handled: true };
    }

    // Resolve the elicitation row to build a typed ChatElicitation for
    // the modal. tenant-filter:exempt — `elicitation_id` is a globally
    // unique UUID; the row carries `tenant_id` for downstream scoping.
    const [row] = await db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation_id))
      .limit(1);
    if (!row) {
      logger.warn({
        module: "chat",
        action: "slack.open_elicit.not_found",
        msg: "open_elicit references unknown elicitation",
        elicitation_id,
      });
      return { handled: true };
    }

    const input = (row.input as Record<string, unknown> | null) ?? {};
    const elicitation: ChatElicitation = {
      id: row.id,
      conversation_id: row.conversation_id,
      kind: mapToolNameToKind(row.tool_name),
      summary: (typeof input.summary === "string" && input.summary) || row.tool_name,
    };
    if (typeof input.body === "string") elicitation.body = input.body;
    if (Array.isArray(input.options))
      elicitation.options = input.options as NonNullable<ChatElicitation["options"]>;
    if (Array.isArray(input.fields))
      elicitation.fields = input.fields as NonNullable<ChatElicitation["fields"]>;
    const view = buildElicitationModal(elicitation);

    try {
      await this.client.views.open({ trigger_id, view });
    } catch (err) {
      logger.error({
        module: "chat",
        action: "slack.open_elicit.failed",
        msg: "slack views.open failed",
        elicitation_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Regardless of API outcome: the interaction was handled inline —
    // queueing a duplicate chat.event would only re-trigger lookup work
    // for an action the dispatcher has no resolution for.
    return { handled: true };
  }
}

/**
 * Map an `ask_user_*` tool name to a provider-neutral elicitation kind.
 * Kept here (rather than the dispatcher) so platform adapters can use
 * the same mapping when they need to instantiate a ChatElicitation from
 * a persisted elicitation row.
 */
function mapToolNameToKind(toolName: string): ElicitationKind {
  switch (toolName) {
    case "ask_user_confirm":
      return "confirm";
    case "ask_user_choice":
      return "choice";
    case "ask_user_multi":
      return "multi";
    case "ask_user_text":
      return "text";
    case "ask_user_form":
      return "form";
    default:
      return "confirm";
  }
}

/**
 * Slack `view.state.values[block_id][action_id]` carries a typed value
 * object; pull out the primitive answer regardless of input element
 * type. Returns the raw value for unknown shapes so a future input
 * type doesn't silently lose data.
 */
function extractInputValue(el: Record<string, unknown>): unknown {
  const t = el.type as string | undefined;
  if (t === "plain_text_input") return el.value ?? "";
  if (t === "datepicker") return el.selected_date ?? "";
  if (t === "static_select") {
    const opt = el.selected_option as { value?: unknown } | null;
    return opt?.value ?? "";
  }
  if (t === "multi_static_select") {
    const opts = (el.selected_options as Array<{ value: unknown }>) ?? [];
    return opts.map((o) => o.value);
  }
  if (t === "checkboxes") {
    const opts = (el.selected_options as Array<{ value: unknown }>) ?? [];
    return opts.map((o) => o.value);
  }
  return (el.value as unknown) ?? null;
}
