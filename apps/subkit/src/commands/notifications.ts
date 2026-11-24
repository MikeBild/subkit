import { reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { getNotificationInboxCursor, setNotificationInboxCursor } from "../config.ts";
import type {
  CreateNotificationChannelBody,
  CreateNotificationRuleBody,
  NotificationInboxQuery,
  NotificationSeverity,
  UpdateNotificationChannelBody,
  UpdateNotificationRuleBody,
} from "../engine-client/events.ts";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

export const NOTIFICATION_CHANNEL_COLUMNS = [
  "id",
  "platform",
  "workspace_id",
  "channel_id",
  "active",
];

const SEVERITIES = [
  "debug",
  "info",
  "warn",
  "error",
  "critical",
] as const satisfies readonly NotificationSeverity[];

export function notificationSeverity(value: string): NotificationSeverity {
  const severity = SEVERITIES.find((candidate) => candidate === value);
  if (!severity) throw new Error(`--severity must be one of ${SEVERITIES.join(", ")}`);
  return severity;
}

export function buildCreateChannelBody(args: {
  platform: string;
  "workspace-id": string;
  "channel-id": string;
  severity?: string | undefined;
  rateLimit?: number | undefined;
}): CreateNotificationChannelBody {
  return {
    platform: args.platform,
    workspace_id: args["workspace-id"],
    channel_id: args["channel-id"],
    ...(args.severity ? { default_severity: notificationSeverity(args.severity) } : {}),
    ...(args.rateLimit !== undefined ? { rate_limit_per_minute: args.rateLimit } : {}),
  };
}

export function buildCreateRuleBody(args: {
  event: string;
  "workspace-id": string;
  "channel-id": string;
  name?: string | undefined;
  severity?: string | undefined;
}): CreateNotificationRuleBody {
  return {
    name: args.name ?? args.event,
    event_pattern: args.event,
    target_workspace_id: args["workspace-id"],
    target_channel_id: args["channel-id"],
    ...(args.severity ? { severity: notificationSeverity(args.severity) } : {}),
  };
}

export function buildInboxQuery(args: {
  all?: boolean | undefined;
  unread?: boolean | undefined;
  actionable?: boolean | undefined;
  limit?: string | undefined;
}): NotificationInboxQuery {
  const query: NotificationInboxQuery = {};
  if (!args.all) query.since = getNotificationInboxCursor();
  if (args.limit) query.limit = Number(args.limit);
  if (args.unread) query.unread_only = "true";
  if (args.actionable) query.actionable_only = "true";
  return query;
}

const channelsListCmd = defineCommand({
  meta: { name: "list", description: "List notification channels" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listNotificationChannels();
        emitList(!!args.json, NOTIFICATION_CHANNEL_COLUMNS, items);
      },
      { json: Boolean(args.json) },
    );
  },
});

const channelsGetCmd = defineCommand({
  meta: { name: "get", description: "Get a notification channel" },
  args: {
    id: { type: "positional", required: true, description: "Channel id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(
        await client.listNotificationChannels().then(
          ({ items }) =>
            items.find((c) => c.id === args.id) ??
            (() => {
              throw new Error(`channel ${args.id} not found`);
            })(),
        ),
      );
    });
  },
});

const channelsCreateCmd = defineCommand({
  meta: { name: "create", description: "Create a notification channel" },
  args: {
    platform: {
      type: "string",
      required: true,
      description: "Chat platform the channel lives on: slack, teams or google_chat",
    },
    "workspace-id": {
      type: "string",
      required: true,
      description: "Workspace id on that platform (the chat workspace the channel lives in)",
    },
    "channel-id": { type: "string", required: true, description: "Channel id on that platform" },
    severity: {
      type: "string",
      description: "Default severity: debug, info, warn, error or critical (default: info)",
    },
    "rate-limit": {
      type: "string",
      description: "Deliveries allowed per minute, a positive integer (default: 60)",
    },
  },
  async run({ args }) {
    const rateLimit = args["rate-limit"] === undefined ? undefined : Number(args["rate-limit"]);
    if (rateLimit !== undefined && !(Number.isInteger(rateLimit) && rateLimit > 0)) {
      process.stderr.write("--rate-limit must be a positive integer\n");
      process.exit(1);
    }
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(
        await client.createNotificationChannel(buildCreateChannelBody({ ...args, rateLimit })),
      );
    });
  },
});

const channelsUpdateCmd = defineCommand({
  meta: { name: "update", description: "Update a notification channel" },
  args: {
    id: { type: "positional", required: true, description: "Channel id" },
    config: { type: "string", required: true, description: "Patch body as JSON string" },
  },
  async run({ args }) {
    const client = makeClient();
    let body: UpdateNotificationChannelBody;
    try {
      body = JSON.parse(args.config as string);
    } catch {
      process.stderr.write("invalid JSON for --config\n");
      process.exit(1);
    }
    return withCommandErrors(async () => {
      printJson(await client.patchNotificationChannel(args.id, body));
    });
  },
});

const channelsDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a notification channel" },
  args: {
    id: { type: "positional", required: true, description: "Channel id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.deleteNotificationChannel(args.id);
      process.stdout.write("deleted\n");
    });
  },
});

const channelsCmd = defineCommand({
  meta: { name: "channels", description: "Manage notification channels" },
  subCommands: {
    list: channelsListCmd,
    get: channelsGetCmd,
    create: channelsCreateCmd,
    update: channelsUpdateCmd,
    delete: channelsDeleteCmd,
  },
});

const rulesListCmd = defineCommand({
  meta: { name: "list", description: "List notification rules" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listNotificationRules();
        emitList(
          !!args.json,
          ["id", "name", "event_pattern", "target_channel_id", "active"],
          items,
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

const rulesGetCmd = defineCommand({
  meta: { name: "get", description: "Get a notification rule" },
  args: {
    id: { type: "positional", required: true, description: "Rule id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(
        await client.listNotificationRules().then(
          ({ items }) =>
            items.find((r) => r.id === args.id) ??
            (() => {
              throw new Error(`rule ${args.id} not found`);
            })(),
        ),
      );
    });
  },
});

const rulesCreateCmd = defineCommand({
  meta: { name: "create", description: "Create a notification rule" },
  args: {
    event: {
      type: "string",
      required: true,
      description:
        "Event pattern: an event type, a glob like execution.*, or a comma-separated list",
    },
    "workspace-id": {
      type: "string",
      required: true,
      description: "Target workspace id (the chat workspace the channel lives in)",
    },
    "channel-id": { type: "string", required: true, description: "Target channel id" },
    name: { type: "string", description: "Rule name (default: the event pattern)" },
    severity: {
      type: "string",
      description: "Severity floor: debug, info, warn, error or critical (default: info)",
    },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.createNotificationRule(buildCreateRuleBody(args)));
    });
  },
});

const rulesUpdateCmd = defineCommand({
  meta: { name: "update", description: "Update a notification rule" },
  args: {
    id: { type: "positional", required: true, description: "Rule id" },
    body: { type: "string", required: true, description: "Patch body as JSON string" },
  },
  async run({ args }) {
    const client = makeClient();
    let body: UpdateNotificationRuleBody;
    try {
      body = JSON.parse(args.body as string);
    } catch {
      process.stderr.write("invalid JSON for body\n");
      process.exit(1);
    }
    return withCommandErrors(async () => {
      printJson(await client.patchNotificationRule(args.id, body));
    });
  },
});

const rulesDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a notification rule" },
  args: {
    id: { type: "positional", required: true, description: "Rule id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.deleteNotificationRule(args.id);
      process.stdout.write("deleted\n");
    });
  },
});

const rulesCmd = defineCommand({
  meta: { name: "rules", description: "Manage notification rules" },
  subCommands: {
    list: rulesListCmd,
    get: rulesGetCmd,
    create: rulesCreateCmd,
    update: rulesUpdateCmd,
    delete: rulesDeleteCmd,
  },
});

const deliveriesListCmd = defineCommand({
  meta: { name: "list", description: "List notification deliveries" },
  args: {
    limit: { type: "string", description: "Max rows", default: "50" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listNotificationDeliveries(
          args.limit ? { limit: Number(args.limit) } : {},
        );
        emitList(!!args.json, ["id", "channel_id", "event_type", "status", "created_at"], items);
      },
      { json: Boolean(args.json) },
    );
  },
});

const deliveriesCmd = defineCommand({
  meta: { name: "deliveries", description: "Notification deliveries" },
  subCommands: { list: deliveriesListCmd },
});

const inboxListArgs = {
  all: { type: "boolean", description: "Show everything queued, ignoring the stored cursor" },
  unread: { type: "boolean", description: "Only tasks you have not marked read" },
  actionable: { type: "boolean", description: "Only tasks that need someone to act" },
  limit: { type: "string", description: "Max rows (<=500)" },
  json: { type: "boolean", description: "JSON output" },
} as const;

async function runInboxList(args: {
  all?: boolean | undefined;
  unread?: boolean | undefined;
  actionable?: boolean | undefined;
  limit?: string | undefined;
  json?: boolean | undefined;
}): Promise<void> {
  const client = makeClient();
  try {
    const { items, cursor } = await client.getNotificationInbox(buildInboxQuery(args));
    emitList(!!args.json, ["id", "severity", "actionable", "event_type", "created_at"], items);
    setNotificationInboxCursor(cursor);
  } catch (err) {
    reportCommandError(err, { json: Boolean(args.json) });
  }
}

const inboxListCmd = defineCommand({
  meta: { name: "list", description: "Show queued inbox notifications since the last seen cursor" },
  args: inboxListArgs,
  run: ({ args }) => runInboxList(args),
});

const inboxAckCmd = defineCommand({
  meta: { name: "ack", description: "Mark inbox notifications read up to a cursor" },
  args: {
    "up-to": {
      type: "string",
      description: "Cursor id to ack up to (defaults to the last-seen stored cursor)",
    },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    let upToCursor: number;
    if (args["up-to"] !== undefined) {
      upToCursor = Number(args["up-to"]);
      if (!Number.isFinite(upToCursor)) {
        process.stderr.write("--up-to must be a number\n");
        process.exit(1);
      }
    } else {
      upToCursor = getNotificationInboxCursor();
    }
    return withCommandErrors(
      async () => {
        const result = await client.ackNotificationInbox(upToCursor);
        if (args.json) {
          printJson(result);
        } else {
          process.stdout.write(`acked ${result.acked}\n`);
        }
      },
      { json: Boolean(args.json) },
    );
  },
});

const inboxCmd = defineCommand({
  meta: { name: "inbox", description: "Read and acknowledge queued notifications" },
  args: inboxListArgs,
  subCommands: {
    list: inboxListCmd,
    ack: inboxAckCmd,
  },
  default: "list",
});

export const notificationsCommand = defineCommand({
  meta: {
    name: "notifications",
    description: "Manage notification channels, rules, deliveries, and the inbox",
  },
  subCommands: {
    channels: channelsCmd,
    rules: rulesCmd,
    deliveries: deliveriesCmd,
    inbox: inboxCmd,
  },
});
