import { z } from "zod";

const ChannelObj = z.object({ id: z.string().min(1) }).passthrough();
const UserObj = z.object({ id: z.string().min(1) }).passthrough();
const TeamObj = z.object({ id: z.string().min(1) }).passthrough();

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

type ParsedSlackPayload =
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
