// Google Chat chat adapter.
//
//   - Inbound verification: JWT signed by chat@system.gserviceaccount.com,
//     audience = bot's google_client_id. Issuer / audience / JWKS URL
//     are all injectable so tests hit a local mock.
//   - Outbound auth: service-account JWT assertion → token endpoint
//     → access_token (cached via GoogleAuth).
//   - Outbound send: POST to `${baseUrl}/v1/spaces/${name}/messages`.
//   - Approval prompt: Card v2 with a buttonList of two buttons.

import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify } from "jose";
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
import { GoogleAuth, type GoogleAuthOptions } from "./auth.ts";
import {
  buildDialogCloseOk,
  buildDialogNotFound,
  buildElicitationDialog,
  renderElicitationCard,
  renderOpenDialogCard,
} from "./cards.ts";

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
  /** All five elicitation kinds render natively: confirm/choice/multi
   *  as inline cardsV2, text/form via a synchronous Dialog (see
   *  `cards.ts` + `handleSyncInteraction`). The legacy sendApproval
   *  card remains only as the unknown-kind fallback. */
  readonly capabilities: ChatAdapterCapabilities = {
    interactive: ["confirm", "choice", "multi", "text", "form"],
  };
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

    // 1:1 human↔app DM detection — drives DM auto-registration in the
    // queue handler (Google user ids are tenant-global, so the linked
    // identity is a sound tenant anchor there).
    const isDm = space.spaceType === "DIRECT_MESSAGE" || space.singleUserBotDm === true;

    // Human-friendly space name (`space.displayName`) — carried so the
    // `workspace_not_installed` deny audit can label a pending-space
    // candidate for the `sk chat` picker. Named spaces have one; DMs and
    // some group chats do not.
    const spaceDisplayName =
      typeof space.displayName === "string" && space.displayName.length > 0
        ? space.displayName
        : undefined;

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

    // A dialog SUBMIT arrives as CARD_CLICKED (unified events, with
    // formInputs) or as legacy SUBMIT_FORM depending on the app config.
    // Both must route as interactions — a fall-through to the system-
    // event branch would silently drop every form answer.
    const common = (raw.common as Record<string, unknown>) ?? {};
    const isInteraction =
      raw.type === "CARD_CLICKED" ||
      raw.type === "SUBMIT_FORM" ||
      (typeof common.invokedFunction === "string" && common.formInputs !== undefined);

    if (isInteraction) {
      // cardsV2 clicks deliver the action through `event.common`:
      // `common.invokedFunction` (the onClick.action.function name) and
      // `common.parameters` as a FLATTENED string:string map. The
      // legacy cards-v1 shape (`event.action.actionMethodName` +
      // `action.parameters` as a {key,value} LIST) is still present on
      // some payloads — keep it as the fallback.
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

      // form_values extraction from `common.formInputs`, split by
      // action_id (cardinality can't discriminate — stringInputs.value
      // is ALWAYS an array): the multi card's CHECK_BOX is named
      // `values` and delivers the whole array; a dialog submit
      // (view_submission) delivers one entry per widget, keyed by
      // widget name (= field.name / `answer`), scalars unwrapped.
      const formInputs =
        common.formInputs && typeof common.formInputs === "object"
          ? (common.formInputs as Record<string, Record<string, unknown>>)
          : {};
      const interaction: ChatInteractionAction = { action_id: actionId, value: valueParam };
      if (/^elicit:[^:]+:multi:submit$/.test(actionId)) {
        const si = formInputs.values?.stringInputs as { value?: unknown[] } | undefined;
        interaction.form_values = {
          values: Array.isArray(si?.value) ? si.value.map(String) : [],
        };
      } else if (actionId === "view_submission") {
        const fv: Record<string, unknown> = {};
        for (const [name, input] of Object.entries(formInputs)) {
          const si = (input.stringInputs as { value?: unknown[] } | undefined)?.value;
          const di = (input.dateInput as { msSinceEpoch?: unknown } | undefined)?.msSinceEpoch;
          if (Array.isArray(si)) {
            fv[name] = si.length > 1 ? si.map(String) : String(si[0] ?? "");
          } else if (di != null) {
            // DATE_ONLY picker: msSinceEpoch at UTC midnight → YYYY-MM-DD.
            fv[name] = new Date(Number(di)).toISOString().slice(0, 10);
          }
        }
        interaction.form_values = fv;
      }

      return {
        platform: "google_chat",
        workspace_id: (space.name as string) ?? "",
        channel_id: (space.name as string) ?? "",
        ...(threadId ? { thread_id: threadId } : {}),
        user_id: (user.name as string) ?? "",
        kind: "interaction",
        interaction,
        ...(isDm ? { is_direct_message: true } : {}),
        ...(spaceDisplayName ? { space_display_name: spaceDisplayName } : {}),
        ...(eventKey ? { event_key: eventKey } : {}),
        raw: ev.raw,
      };
    }

    // Every remaining non-MESSAGE event type is a system event the
    // dispatcher must ack-and-ignore instead of running a turn on —
    // the live EventType enum also carries ADDED_TO_SPACE,
    // REMOVED_FROM_SPACE, APP_COMMAND, WIDGET_UPDATED, APP_HOME, and
    // Google adds more without notice. (Interaction shapes — incl. the
    // legacy SUBMIT_FORM dialog submit — were routed above.)
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
        ...(isDm ? { is_direct_message: true } : {}),
        ...(spaceDisplayName ? { space_display_name: spaceDisplayName } : {}),
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
      ...(isDm ? { is_direct_message: true } : {}),
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

  /**
   * Post a message body into a space, honoring an optional thread. A
   * thread reply REQUIRES the `messageReplyOption` query parameter:
   * with the default (UNSPECIFIED) the API silently ignores any thread
   * in the body and starts a NEW thread — which would fork the
   * thread-keyed conversation without anyone noticing. OR_FAIL makes
   * the miss loud (404) so we can degrade deliberately to a top-level
   * message (covers DM threads, where in-thread replies are
   * undocumented API surface). Shared by send / renderElicitation /
   * sendApproval so replies, prompts, and approval cards all land in
   * the thread their conversation lives in.
   */
  private async postMessage(
    channel_id: string,
    thread_id: string | undefined,
    body: Record<string, unknown>,
    label: string,
  ): Promise<{ platform_message_id: string }> {
    const threadName = thread_id
      ? thread_id.startsWith("spaces/")
        ? thread_id
        : `${channel_id}/threads/${thread_id}`
      : null;
    const basePath = this.messagesPath(channel_id);
    if (threadName) {
      const res = await this.post(`${basePath}?messageReplyOption=REPLY_MESSAGE_OR_FAIL`, {
        ...body,
        thread: { name: threadName },
      });
      if (res.ok) {
        const json = (await res.json()) as { name?: string };
        return { platform_message_id: json.name ?? "" };
      }
      if (res.status !== 404) throw new Error(`google_chat ${label} failed: ${res.status}`);
      // Thread not addressable (e.g. DM thread) — fall through to a
      // top-level send so the message is never dropped.
    }
    const res = await this.post(basePath, body);
    if (!res.ok) throw new Error(`google_chat ${label} failed: ${res.status}`);
    const json = (await res.json()) as { name?: string };
    return { platform_message_id: json.name ?? "" };
  }

  async send(delivery: ChatDelivery): Promise<{ platform_message_id: string }> {
    return this.postMessage(
      delivery.channel_id,
      delivery.thread_id,
      { text: delivery.text ?? "" },
      "send",
    );
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
    return this.postMessage(
      card.channel_id,
      card.thread_id,
      cardV2 as Record<string, unknown>,
      "approval",
    );
  }

  /**
   * Native elicitation rendering. confirm/choice/multi post an inline
   * interactive card; text/form post an opener card whose button makes
   * Google request a Dialog synchronously (see `handleSyncInteraction`).
   * Posted async via the same messages path `sendApproval` uses.
   */
  async renderElicitation(
    elicitation: ChatElicitation,
    target: { tenant_id: string; workspace_id: string; channel_id: string; thread_id?: string },
  ): Promise<{ platform_message_id: string }> {
    const body =
      elicitation.kind === "text" || elicitation.kind === "form"
        ? renderOpenDialogCard(elicitation)
        : renderElicitationCard(elicitation);
    return this.postMessage(
      target.channel_id,
      target.thread_id,
      body as Record<string, unknown>,
      "renderElicitation",
    );
  }

  /**
   * Synchronous fast path for the events endpoint — Google can only
   * open a Dialog as the SYNC HTTP response to an OPEN_DIALOG click
   * (there is no async views.open equivalent), and a dialog submit
   * needs an immediate close-ack while the (>30s) LLM resolution runs
   * async via the queue.
   *
   *   open_elicit:<id>  → {handled, response: DIALOG body, enqueue: false}
   *   view_submission   → {handled, response: OK close-ack, enqueue: true}
   *   anything else     → {handled: false} (route enqueues + {ok:true})
   */
  async handleSyncInteraction(args: {
    event: ChatEvent;
    db: Db;
  }): Promise<{ handled: boolean; response?: unknown; enqueue?: boolean }> {
    const { event, db } = args;
    if (event.kind !== "interaction" || !event.interaction) return { handled: false };
    const action_id = event.interaction.action_id;

    if (action_id === "view_submission") {
      // Close the dialog immediately; the answer (form_values from
      // receive()) resolves asynchronously through routeChatInteraction
      // — which owns ALL tenant/actor/validation checks.
      return { handled: true, enqueue: true, response: buildDialogCloseOk() };
    }

    const m = /^open_elicit:(.+)$/.exec(action_id);
    if (!m) return { handled: false };
    const elicitation_id = m[1] ?? "";

    // Tenant scoping is REQUIRED: the app-level JWT only proves "from
    // Google to this app", not "from tenant T". An unscoped lookup by
    // id would let a probing click render another tenant's elicitation
    // summary/body/options/fields into this space's dialog. Bind the
    // lookup to the workspace's tenant first; unknown workspace,
    // unknown id, and foreign-tenant id all produce the SAME
    // probe-resistant "expired" dialog.
    // tenant-filter:exempt — platform/workspace_id lookup pre-tenant
    // (mirrors the Slack open_elicit path and the chat-event handler).
    const [workspace] = await db
      .select({ tenant_id: chatWorkspaces.tenant_id })
      .from(chatWorkspaces)
      .where(
        and(
          eq(chatWorkspaces.platform, "google_chat"),
          eq(chatWorkspaces.workspace_id, event.workspace_id),
        ),
      )
      .limit(1);
    if (!workspace) {
      logger.warn({
        module: "chat",
        action: "google.open_elicit.unknown_workspace",
        msg: "open_elicit from a space with no chat_workspaces row",
        platform_workspace_id: event.workspace_id,
      });
      return { handled: true, enqueue: false, response: buildDialogNotFound() };
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
      logger.warn({
        module: "chat",
        action: "google.open_elicit.not_found",
        msg: "open_elicit references unknown elicitation (or wrong tenant)",
        tenant_id: workspace.tenant_id,
        elicitation_id,
      });
      return { handled: true, enqueue: false, response: buildDialogNotFound() };
    }

    const input = (row.input as Record<string, unknown> | null) ?? {};
    const kind = mapToolNameToKind(row.tool_name);
    if (kind === null) {
      logger.warn({
        module: "chat",
        action: "google.open_elicit.unknown_tool",
        msg: "open_elicit row references an unknown ask_user_* tool — skipping dialog",
        elicitation_id,
        tool_name: row.tool_name,
      });
      return { handled: true, enqueue: false, response: buildDialogNotFound() };
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
      // ElicitationField.default is `string`; engine form fields may
      // carry number/boolean/string[] defaults — coerce to string at
      // this boundary, drop array defaults (same coercion as Slack).
      elicitation.fields = (input.fields as Array<Record<string, unknown>>).map((f) => {
        const { default: def, ...rest } = f;
        if (def === undefined || Array.isArray(def)) return rest;
        return { ...rest, default: String(def) };
      }) as unknown as NonNullable<ChatElicitation["fields"]>;
    }
    return { handled: true, enqueue: false, response: buildElicitationDialog(elicitation) };
  }
}
