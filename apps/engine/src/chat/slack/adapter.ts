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
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { chatWorkspaces, conversationElicitations } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import type { ChatAdapter } from "../adapter.ts";
import { mapToolNameToKind } from "../api.ts";
import type {
  ApprovalCard,
  ChatAdapterCapabilities,
  ChatDelivery,
  ChatElicitation,
  ChatEvent,
  ChatInteractionAction,
  VerifiedEvent,
} from "../types.ts";
import {
  buildElicitationModal,
  renderApprovalBlocks,
  renderInlineElicitationBlocks,
  renderMessageBlocks,
  renderOpenFormBlocks,
} from "./block-kit.ts";
import { parseSlackInboundPayload } from "./payloads.ts";
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
    // Single parse choke-point: every Slack inbound shape runs through
    // `parseSlackInboundPayload` which enforces required fields via
    // Zod schemas (`payloads.ts`). A renamed-required-field drift in
    // the Slack contract surfaces as a logged warn rather than
    // dispatching with silently-defaulted IDs.
    const parsed = parseSlackInboundPayload(ev.raw);

    if (parsed.kind === "app_mention") {
      const inner = parsed.inner;
      return {
        platform: "slack",
        workspace_id: parsed.team_id,
        channel_id: inner.channel,
        thread_id: inner.thread_ts ?? inner.ts,
        user_id: inner.user,
        kind: "mention",
        text: inner.text,
        ...(parsed.event_id ? { event_key: parsed.event_id } : {}),
        raw: ev.raw,
      };
    }

    if (parsed.kind === "message_im") {
      const inner = parsed.inner;
      // Bot-echo suppression: Slack delivers the bot's own DMs through
      // this same event stream. Drop messages carrying `bot_id`, any
      // `subtype` (`bot_message`, `message_changed`, …), or
      // `app_id` — together these cover every self-emitted shape.
      // Treat IM-only events; channel-type other than "im" isn't
      // routed to the dispatcher.
      if (inner.channel_type !== "im") {
        throw new Error(`slack: unrecognized event shape`);
      }
      if (inner.bot_id || inner.subtype || inner.app_id || !inner.user) {
        throw new Error(`slack: unrecognized event shape`);
      }
      return {
        platform: "slack",
        workspace_id: parsed.team_id,
        channel_id: inner.channel,
        // DMs have no `thread_ts`; fall back to `ts` so the dispatcher
        // maps the whole DM to one conversation 1:1.
        thread_id: inner.thread_ts ?? inner.ts,
        user_id: inner.user,
        // Normalize to "mention" so the dispatcher takes the same
        // bare-text-as-prompt branch as channel @mentions.
        kind: "mention",
        text: inner.text,
        ...(parsed.event_id ? { event_key: parsed.event_id } : {}),
        raw: ev.raw,
      };
    }

    if (parsed.kind === "view_submission") {
      const data = parsed.data;
      const view = data.view;
      const channel_id = data.channel?.id ?? "";
      const workspace_id = data.team?.id ?? data.team_id ?? "";

      // Flatten Slack's nested view.state.values shape into a flat
      // `{ field_name: primitive }` dict the dispatcher passes
      // directly into respondElicitation. Adapters elsewhere produce
      // the same shape — the dispatcher stays provider-agnostic.
      const stateValues = view.state?.values ?? {};
      const form_values: Record<string, unknown> = {};
      for (const [blockId, elements] of Object.entries(stateValues)) {
        if (!blockId.startsWith("field:")) continue;
        const name = blockId.slice("field:".length);
        const elKey = `el:${name}`;
        const el = (elements as Record<string, unknown>)?.[elKey] as
          | Record<string, unknown>
          | undefined;
        if (!el) continue;
        form_values[name] = extractInputValue(el);
      }

      const interaction: ChatInteractionAction = {
        action_id: "view_submission",
        ...(view.private_metadata ? { value: view.private_metadata } : {}),
        form_values,
      };
      return {
        platform: "slack",
        workspace_id,
        channel_id,
        user_id: data.user.id,
        kind: "interaction",
        interaction,
        event_key: view.id,
        raw: ev.raw,
      };
    }

    if (parsed.kind === "block_actions") {
      const data = parsed.data;
      const channel_id = data.channel?.id ?? "";
      const workspace_id = data.team?.id ?? data.team_id ?? "";
      const a = data.actions[0]!;
      const action_id = a.action_id;
      const interaction: ChatInteractionAction = {
        action_id,
        ...(typeof a.value === "string" ? { value: a.value } : {}),
      };
      // For a `multi` submit click, the selected checkboxes live in
      // the message's state.values keyed by the checkboxes block_id;
      // re-encode them into form_values.values for the dispatcher.
      const multiMatch = /^elicit:([^:]+):multi:submit$/.exec(action_id);
      if (multiMatch) {
        const stateValues = data.state?.values ?? {};
        const optsBlockId = `subkit_elicit_opts:${multiMatch[1]}`;
        const optsElementId = `elicit:${multiMatch[1]}:multi:select`;
        const elements = (stateValues as Record<string, unknown>)[optsBlockId] as
          | Record<string, unknown>
          | undefined;
        const checkboxes = elements?.[optsElementId] as Record<string, unknown> | undefined;
        const selected =
          (checkboxes?.selected_options as Array<{ value: string }> | undefined) ?? [];
        interaction.form_values = { values: selected.map((s) => s.value) };
      }
      const thread_id = data.message?.thread_ts ?? data.message?.ts;
      return {
        platform: "slack",
        workspace_id,
        channel_id,
        ...(thread_id ? { thread_id } : {}),
        user_id: data.user.id,
        kind: "interaction",
        interaction,
        ...(data.trigger_id ? { event_key: data.trigger_id } : {}),
        raw: ev.raw,
      };
    }

    if (parsed.kind === "slash") {
      const form = parsed.data;
      // Stable dedup key: a retry of the same submission collides; two
      // distinct invocations don't.
      const stableKey = `slash:${form.team_id}:${form.command}:${form.text}:${form.trigger_id ?? form.user_id}`;
      return {
        platform: "slack",
        workspace_id: form.team_id,
        channel_id: form.channel_id,
        user_id: form.user_id,
        kind: "slash_command",
        text: `${form.command} ${form.text}`.trim(),
        event_key: stableKey,
        raw: ev.raw,
      };
    }

    // parsed.kind === "unknown" — schema rejected the payload. Surface
    // the reason so a Slack contract drift shows up in diagnostics
    // before it manifests as silently-dropped events.
    logger.warn({
      module: "chat",
      action: "slack.receive.payload_rejected",
      msg: "slack inbound payload did not match any known schema",
      reason: parsed.reason,
    });
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
    // the modal.
    //
    // Tenant scoping is required here: the chat route uses ONE app-
    // level signing secret across every installed workspace, so
    // verify() succeeding only proves "this came from Slack to
    // subkit's app" — not "from tenant T_X". An unscoped lookup by
    // id would let a user in workspace W_A click an
    // `open_elicit:<harvested-id>` button and see tenant T_B's
    // elicitation `summary`/`body`/`options`/`fields` rendered into
    // W_A's modal. We bind the lookup to the workspace's tenant first.
    // tenant-filter:exempt — platform/workspace_id lookup pre-tenant
    // (mirrors dispatcher.ts:handleChatEvent and chat-event handler).
    const [workspace] = await db
      .select({ tenant_id: chatWorkspaces.tenant_id })
      .from(chatWorkspaces)
      .where(
        and(
          eq(chatWorkspaces.platform, "slack"),
          eq(chatWorkspaces.workspace_id, event.workspace_id),
        ),
      )
      .limit(1);
    if (!workspace) {
      logger.warn({
        module: "chat",
        action: "slack.open_elicit.unknown_workspace",
        msg: "open_elicit from a workspace with no chat_workspaces row",
        platform_workspace_id: event.workspace_id,
      });
      return { handled: true };
    }

    const [row] = await db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, workspace.tenant_id),
          eq(conversationElicitations.id, elicitation_id),
        ),
      )
      .limit(1);
    if (!row) {
      // Either the id is unknown OR it exists in a different tenant —
      // both produce the same "not found" outcome. We DO NOT log the
      // elicitation_id at info level to avoid teaching a probing
      // attacker which ids exist; warn-level is fine.
      logger.warn({
        module: "chat",
        action: "slack.open_elicit.not_found",
        msg: "open_elicit references unknown elicitation (or wrong tenant)",
        tenant_id: workspace.tenant_id,
        elicitation_id,
      });
      return { handled: true };
    }

    const input = (row.input as Record<string, unknown> | null) ?? {};
    const kind = mapToolNameToKind(row.tool_name);
    if (kind === null) {
      logger.warn({
        module: "chat",
        action: "slack.open_elicit.unknown_tool",
        msg: "open_elicit row references an unknown ask_user_* tool — skipping modal",
        elicitation_id,
        tool_name: row.tool_name,
      });
      return { handled: true };
    }
    const elicitation: ChatElicitation = {
      id: row.id,
      conversation_id: row.conversation_id,
      kind,
      summary: (typeof input.summary === "string" && input.summary) || row.tool_name,
    };
    if (typeof input.body === "string") elicitation.body = input.body;
    if (Array.isArray(input.options))
      elicitation.options = input.options as NonNullable<ChatElicitation["options"]>;
    if (Array.isArray(input.fields)) {
      // ElicitationField.default is `string` (Block-Kit initial_value);
      // engine form fields may carry number/boolean/string[] defaults —
      // coerce to string at this boundary, drop array defaults (Slack
      // multi pre-selection is not wired).
      elicitation.fields = (input.fields as Array<Record<string, unknown>>).map((f) => {
        const { default: def, ...rest } = f;
        if (def === undefined || Array.isArray(def)) return rest;
        return { ...rest, default: String(def) };
      }) as unknown as NonNullable<ChatElicitation["fields"]>;
    }
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
