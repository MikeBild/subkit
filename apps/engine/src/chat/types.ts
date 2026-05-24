// Shared chat adapter types.
//
// P12 ships the core of the chat layer — enough to drive a full
// mention → conversation → approval → commit through Slack, with
// Teams and Google Chat implemented at parity for signing and
// outbound API calls.

export type ChatPlatform = "slack" | "teams" | "google_chat";

/**
 * Platform-tagged raw envelope. A request that has successfully
 * passed `adapter.verify()` turns into a `VerifiedEvent`. The `raw`
 * field is the already-parsed JSON body (or form payload for Slack
 * interactions) — adapters do their own normalization in `receive()`.
 */
export interface VerifiedEvent {
  platform: ChatPlatform;
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
  platform: ChatPlatform;
  workspace_id: string;
  channel_id: string;
  thread_id?: string;
  user_id: string;
  kind: "mention" | "slash_command" | "interaction";
  text?: string;
  command?: ChatCommand;
  interaction?: ChatInteractionAction;
  /** Platform-native event id used for replay dedup (`chat/dedup.ts`).
   *  Populated by the adapter's `receive()`. Slack: `event_id`
   *  (Events API), `view.id` (`view_submission`), `trigger_id`
   *  (`block_actions`), or hash of `command+text+ts` (slash). */
  event_key?: string;
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
export const CHAT_RATES: Record<ChatPlatform, { per_minute: number; burst: number }> = {
  slack: { per_minute: 60, burst: 20 },
  teams: { per_minute: 30, burst: 10 },
  google_chat: { per_minute: 60, burst: 20 },
};
