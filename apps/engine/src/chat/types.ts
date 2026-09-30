// Shared chat adapter types.
//
// P12 ships the core of the chat layer — enough to drive a full
// mention → conversation → approval → commit through Slack, with
// Teams and Google Chat implemented at parity for signing and
// outbound API calls.

// Platforms that ingest inbound traffic (verify → receive → dispatch).
// These map 1:1 to a `chat_workspaces` row and the `chat_platform`
// pgEnum, so any value that flows through `VerifiedEvent` / `ChatEvent`
// or a `chat_workspaces.platform` comparison must be one of these.
export type InboundChatPlatform = "slack" | "teams" | "google_chat";

// `sk_cli` is an outbound-only, fallback-resolved pseudo-platform: the
// `SkCliAdapter` turns a notification delivery into a local
// `cli_notification_inbox` row. It never participates in inbound
// verify/receive — there is no signing secret, no webhook ingress, no
// `chat_workspaces` row — so it carries no rate ceiling (a local INSERT
// needs none) and is excluded from `InboundChatPlatform`.
export type ChatPlatform = InboundChatPlatform | "sk_cli";

/**
 * What an outbound-only sink reports after `send`. A sink that deliberately
 * does not persist an event says so rather than answering like a delivery,
 * so the dispatcher records neither a `sent` row nor a sent-message audit
 * for something nobody received.
 */
export type OutboundSendResult = { platform_message_id: string } | { skipped: OutboundSkipReason };

/** Why an outbound-only sink passed on an event. */
export type OutboundSkipReason = "not_actionable";

/**
 * Platform-tagged raw envelope. A request that has successfully
 * passed `adapter.verify()` turns into a `VerifiedEvent`. The `raw`
 * field is the already-parsed JSON body (or form payload for Slack
 * interactions) — adapters do their own normalization in `receive()`.
 */
export interface VerifiedEvent {
  platform: InboundChatPlatform;
  raw: unknown;
}

export type ChatCommand =
  | { verb: "chat"; prompt: string }
  | { verb: "run"; workflow: string; args: Record<string, string> }
  | { verb: "help"; topic?: string };

export interface ChatInteractionAction {
  action_id: string;
  value?: string;
  /** Structured form values produced by a native multi-field submission
   *  (Slack `view_submission.view.state.values`, Teams Adaptive Card
   *  `value`, Google dialog form data). Field name → primitive answer.
   *  When present, the dispatcher passes this directly to
   *  `respondElicitation({ output })` so a `form` elicitation receives
   *  one atomic typed payload — no field-by-field text round-trips. */
  form_values?: Record<string, unknown>;
}

/** Subset of `ask_user_*` tool kinds the adapter knows how to render
 *  natively. Declared per-adapter via `ChatAdapter.capabilities` so the
 *  dispatcher can stay provider-agnostic when handing off an
 *  elicitation for rendering. */
export type ElicitationKind = "confirm" | "choice" | "multi" | "text" | "form";

export interface ElicitationField {
  name: string;
  label?: string;
  /** Coarse input hint — adapters pick the closest native widget
   *  (text/email/number/date map to Slack `plain_text_input`, a
   *  `Input.Text` in Teams, a `textInput` in Google Chat; `select`
   *  uses each platform's native single-select). */
  type?: "text" | "textarea" | "number" | "email" | "date" | "select";
  options?: Array<{ value: string; label?: string }>;
  required?: boolean;
  placeholder?: string;
  default?: string;
}

/** Provider-neutral elicitation descriptor handed to
 *  `ChatAdapter.renderElicitation`. The conversation pipeline owns the
 *  semantics; the adapter owns rendering. */
export interface ChatElicitation {
  id: string;
  conversation_id: string;
  kind: ElicitationKind;
  summary: string;
  /** Long-form description shown alongside the form/buttons. */
  body?: string;
  /** `choice` and `multi` options. */
  options?: Array<{ value: string; label?: string }>;
  /** `form` field list. */
  fields?: ElicitationField[];
}

export interface ChatAdapterCapabilities {
  /** Elicitation kinds this adapter renders as native interactive UI.
   *  Kinds not listed here will fall back to the legacy `sendApproval`
   *  path. Slack declares all five once its native renderers ship. */
  interactive: ElicitationKind[];
}

export interface ChatEvent {
  platform: InboundChatPlatform;
  workspace_id: string;
  channel_id: string;
  thread_id?: string;
  user_id: string;
  /** `system` = non-conversational platform event (membership change,
   *  app-home ping, unknown event type). The dispatcher never runs a
   *  turn for it; `system_event: "removed_from_space"` additionally
   *  drops the channel's `chat_sessions` bindings so outbound replies
   *  stop targeting a space the app is no longer a member of. */
  kind: "mention" | "slash_command" | "interaction" | "system";
  text?: string;
  command?: ChatCommand;
  interaction?: ChatInteractionAction;
  /** Set when `kind === "system"` — the platform-native event type,
   *  normalized (`removed_from_space`, `added_to_space`, or the raw
   *  platform event name for unknown types). */
  system_event?: string;
  /** True when the originating space is a 1:1 DM between one human and
   *  the app (Google: `space.spaceType === "DIRECT_MESSAGE"` or
   *  `singleUserBotDm`). Drives DM auto-registration for platforms
   *  whose user ids are tenant-global (`PLATFORM_HAS_GLOBAL_USER_IDS`). */
  is_direct_message?: boolean;
  /** Human-friendly space/channel name when the platform supplies one
   *  (Google `space.displayName`). Surfaced only in the
   *  `workspace_not_installed` deny audit so the `sk chat` pending-space
   *  picker can label a candidate by its name rather than the raw
   *  `spaces/<id>`. Absent for DMs and platforms that carry no name. */
  space_display_name?: string;
  /** Platform-native event id used for replay dedup (`chat/dedup.ts`).
   *  Populated by the adapter's `receive()`. Slack: `event_id`
   *  (Events API), `view.id` (`view_submission`), `trigger_id`
   *  (`block_actions`), or hash of `command+text+ts` (slash). */
  event_key?: string;
  /** Canary classification propagated from a verified ingress header. */
  traffic_class?: "organic" | "synthetic" | "internal";
  raw: unknown;
}

export interface ChatDelivery {
  tenant_id: string;
  workspace_id: string;
  channel_id: string;
  thread_id?: string;
  kind: "message" | "ephemeral" | "approval";
  text?: string;
  blocks?: unknown;
  card?: ApprovalCard;
  /** Structured notification context carried alongside the rendered
   *  `text` when the delivery originates from the notification
   *  dispatcher. Real chat adapters render `text`/`blocks` and ignore
   *  this; the `sk_cli` adapter persists these fields verbatim into a
   *  `cli_notification_inbox` row (the rendered text is for the chat
   *  surface, the structured fields are for the pull-based CLI). */
  notification?: {
    severity: string;
    event_type: string;
    event_payload?: Record<string, unknown> | null;
  };
}

export interface ApprovalCard {
  tenant_id: string;
  workspace_id: string;
  channel_id: string;
  thread_id?: string;
  conversation_id: string;
  approval_id: string;
  summary: string;
  /** Markdown / rich description of what will happen on approve. */
  body?: string;
}

/**
 * Per-platform rate declarations. Notifications flow honors these via
 * `notifications/rate-limit.ts` token bucket. Direct adapter.send
 * traffic from `conversations/dispatcher.ts` is not yet wrapped —
 * deferred work applies the same limiter to all outbound adapter methods.
 */
/**
 * Whether a platform's native user ids identify one human GLOBALLY
 * (across every workspace/space the app sees) rather than per-workspace.
 * Load-bearing for DM auto-registration: matching a DM sender against
 * identities linked in OTHER workspaces is only sound when the id
 * cannot mean a different person elsewhere. Google `users/<id>` is the
 * tenant-global People id (and the event is JWT-verified); Slack `U…`
 * and Teams ids are workspace-scoped — a cross-workspace match there
 * would bridge tenants, so they stay false until a sound scoping
 * (e.g. Slack enterprise-grid team ids) exists.
 */
export const PLATFORM_HAS_GLOBAL_USER_IDS: Record<ChatPlatform, boolean> = {
  slack: false,
  teams: false,
  google_chat: true,
  sk_cli: false,
};

export const CHAT_RATES: Record<ChatPlatform, { per_minute: number; burst: number }> = {
  slack: { per_minute: 60, burst: 20 },
  teams: { per_minute: 30, burst: 10 },
  google_chat: { per_minute: 60, burst: 20 },
  // sk_cli is a local INSERT into `cli_notification_inbox` — no remote
  // API, so no rate ceiling. The dispatcher skips the limiter entirely
  // for this platform; the zeroes here only satisfy the Record contract.
  sk_cli: { per_minute: 0, burst: 0 },
};
