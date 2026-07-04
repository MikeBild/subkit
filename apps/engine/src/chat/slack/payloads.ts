// Zod-validated Slack inbound payload shapes.
//
// `SlackAdapter.receive()` used to walk the raw payload with `as`
// narrowings — a missing field silently became `""` and percolated to
// the dispatcher as `workspace_id: ""` (which then matches no
// `chat_workspaces` row and lands in the unknown-workspace audit
// branch). Slack also evolves its envelope; a new optional field is
// harmless but a renamed required one would silently drop events.
//
// This module is the SINGLE parse choke-point for all four Slack
// inbound shapes:
//
//   - event_callback / app_mention
//   - event_callback / message  (IM channel; bot-echo filter applied
//     later by the adapter, not the schema)
//   - block_actions
//   - view_submission
//   - slash command (form-encoded; adapter wraps form fields under
//     `__slack_form: true` before parsing)
//
// All schemas use `.passthrough()` so unknown Slack-added fields don't
// reject the payload. Required fields are strictly typed (`workspace_id`,
// `user_id`, etc. MUST be present). `parseSlackInboundPayload` returns
// a tagged union the adapter switches on; on a parse failure it returns
// `{ kind: "unknown", issues, raw }` and the adapter logs + throws so
// the malformed event surfaces in metrics rather than dispatching with
// silently-defaulted IDs.

import { z } from "zod";

// ---------------------------------------------------------------------
// Common building blocks
// ---------------------------------------------------------------------

const ChannelObj = z.object({ id: z.string().min(1) }).passthrough();
const UserObj = z.object({ id: z.string().min(1) }).passthrough();
const TeamObj = z.object({ id: z.string().min(1) }).passthrough();

// ---------------------------------------------------------------------
// Events API — event_callback envelopes
// ---------------------------------------------------------------------

const AppMentionInner = z
  .object({
    type: z.literal("app_mention"),
    channel: z.string().min(1),
    user: z.string().min(1),
    text: z.string().default(""),
    ts: z.string().min(1),
    thread_ts: z.string().optional(),
  })
  .passthrough();

const MessageImInner = z
  .object({
    type: z.literal("message"),
    channel_type: z.string().optional(),
    channel: z.string().min(1),
    user: z.string().optional(),
    text: z.string().default(""),
    ts: z.string().min(1),
    thread_ts: z.string().optional(),
    // Bot-echo filter fields — present means "this is the bot's own
    // message; drop it". The schema accepts them; the adapter applies
    // the filter after parsing.
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
    app_id: z.string().optional(),
  })
  .passthrough();

const EventCallback = z
  .object({
    type: z.literal("event_callback"),
    team_id: z.string().min(1),
    event_id: z.string().optional(),
    event: z.union([AppMentionInner, MessageImInner, z.object({}).passthrough()]),
  })
  .passthrough();

// ---------------------------------------------------------------------
// Block-Kit interactions (`block_actions`, `view_submission`)
// ---------------------------------------------------------------------

const BlockAction = z
  .object({
    action_id: z.string().min(1),
    value: z.string().optional(),
  })
  .passthrough();

const StateValuesShape = z
  .record(z.string(), z.record(z.string(), z.unknown().or(z.record(z.string(), z.unknown()))))
  .optional();

const BlockActionsPayload = z
  .object({
    type: z.literal("block_actions"),
    team_id: z.string().optional(),
    team: TeamObj.optional(),
    trigger_id: z.string().optional(),
    channel: ChannelObj.optional(),
    user: UserObj,
    message: z
      .object({ ts: z.string().optional(), thread_ts: z.string().optional() })
      .passthrough()
      .optional(),
    actions: z.array(BlockAction).min(1),
    state: z.object({ values: StateValuesShape }).passthrough().optional(),
  })
  .passthrough()
  // The adapter computes workspace_id = team?.id ?? team_id ?? ""; an
  // empty workspace_id matches no chat_workspaces row and the queue
  // worker drops the event. Reject at the parse boundary so the
  // rejection surfaces in adapter-level metrics instead of slipping
  // through as a silent dispatcher drop.
  .refine((d) => Boolean(d.team?.id ?? d.team_id), {
    message: "block_actions requires `team.id` or `team_id`",
  });

const ViewSubmissionPayload = z
  .object({
    type: z.literal("view_submission"),
    team_id: z.string().optional(),
    team: TeamObj.optional(),
    channel: ChannelObj.optional(),
    user: UserObj,
    view: z
      .object({
        id: z.string().min(1),
        private_metadata: z.string().optional(),
        state: z.object({ values: StateValuesShape }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough()
  .refine((d) => Boolean(d.team?.id ?? d.team_id), {
    message: "view_submission requires `team.id` or `team_id`",
  });

// ---------------------------------------------------------------------
// Slash command (form-encoded; wrapped by the adapter)
// ---------------------------------------------------------------------

const SlashFormPayload = z
  .object({
    __slack_form: z.literal(true),
    team_id: z.string().min(1),
    channel_id: z.string().min(1),
    user_id: z.string().min(1),
    command: z.string().default(""),
    text: z.string().default(""),
    trigger_id: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------
// Tagged-union parser
// ---------------------------------------------------------------------

export type ParsedSlackPayload =
  | {
      kind: "app_mention";
      team_id: string;
      event_id?: string;
      inner: z.infer<typeof AppMentionInner>;
    }
  | {
      kind: "message_im";
      team_id: string;
      event_id?: string;
      inner: z.infer<typeof MessageImInner>;
    }
  | { kind: "block_actions"; data: z.infer<typeof BlockActionsPayload> }
  | { kind: "view_submission"; data: z.infer<typeof ViewSubmissionPayload> }
  | { kind: "slash"; data: z.infer<typeof SlashFormPayload> }
  | { kind: "unknown"; reason: string };

export function parseSlackInboundPayload(raw: unknown): ParsedSlackPayload {
  if (!raw || typeof raw !== "object") {
    return { kind: "unknown", reason: "payload is not an object" };
  }
  const r = raw as Record<string, unknown>;

  if (r.__slack_form === true) {
    const parsed = SlashFormPayload.safeParse(r);
    if (!parsed.success) {
      return { kind: "unknown", reason: `slash:${parsed.error.issues[0]?.message ?? "invalid"}` };
    }
    return { kind: "slash", data: parsed.data };
  }

  if (r.type === "block_actions") {
    const parsed = BlockActionsPayload.safeParse(r);
    if (!parsed.success) {
      return {
        kind: "unknown",
        reason: `block_actions:${parsed.error.issues[0]?.message ?? "invalid"}`,
      };
    }
    return { kind: "block_actions", data: parsed.data };
  }

  if (r.type === "view_submission") {
    const parsed = ViewSubmissionPayload.safeParse(r);
    if (!parsed.success) {
      return {
        kind: "unknown",
        reason: `view_submission:${parsed.error.issues[0]?.message ?? "invalid"}`,
      };
    }
    return { kind: "view_submission", data: parsed.data };
  }

  if (r.type === "event_callback") {
    const parsed = EventCallback.safeParse(r);
    if (!parsed.success) {
      return {
        kind: "unknown",
        reason: `event_callback:${parsed.error.issues[0]?.message ?? "invalid"}`,
      };
    }
    const inner = parsed.data.event as Record<string, unknown>;
    if (inner.type === "app_mention") {
      const mention = AppMentionInner.safeParse(inner);
      if (!mention.success) {
        return {
          kind: "unknown",
          reason: `app_mention:${mention.error.issues[0]?.message ?? "invalid"}`,
        };
      }
      return {
        kind: "app_mention",
        team_id: parsed.data.team_id,
        ...(parsed.data.event_id ? { event_id: parsed.data.event_id } : {}),
        inner: mention.data,
      };
    }
    if (inner.type === "message") {
      const msg = MessageImInner.safeParse(inner);
      if (!msg.success) {
        return { kind: "unknown", reason: `message:${msg.error.issues[0]?.message ?? "invalid"}` };
      }
      return {
        kind: "message_im",
        team_id: parsed.data.team_id,
        ...(parsed.data.event_id ? { event_id: parsed.data.event_id } : {}),
        inner: msg.data,
      };
    }
    return { kind: "unknown", reason: `event_callback inner type: ${String(inner.type)}` };
  }

  return { kind: "unknown", reason: `unrecognised top-level type: ${String(r.type)}` };
}

// Re-export the inner types for the adapter's narrowing convenience.
export type ParsedBlockActions = z.infer<typeof BlockActionsPayload>;
export type ParsedViewSubmission = z.infer<typeof ViewSubmissionPayload>;
