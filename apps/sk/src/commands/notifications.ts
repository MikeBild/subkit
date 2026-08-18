import { reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import {
  getNotificationInboxCursor,
  resolveProfile,
  setNotificationInboxCursor,
} from "../config.ts";
import { EngineClient } from "../engine-client.ts";

function makeClient() {
  const profile = resolveProfile();
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

// ---- channels ----

const channelsListCmd = defineCommand({
  meta: { name: "list", description: "List notification channels" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listNotificationChannels();
      emitList(!!args.json, ["id", "name", "kind", "active"], items as Record<string, unknown>[]);
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const channelsGetCmd = defineCommand({
  meta: { name: "get", description: "Get a notification channel" },
  args: {
    id: { type: "positional", required: true, description: "Channel id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.listNotificationChannels().then(
          ({ items }) =>
            items.find((c) => (c as Record<string, unknown>).id === args.id) ??
            (() => {
              throw new Error(`channel ${args.id} not found`);
            })(),
        ),
      );
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const channelsCreateCmd = defineCommand({
  meta: { name: "create", description: "Create a notification channel" },
  args: {
    name: { type: "string", required: true, description: "Channel name" },
    kind: { type: "string", required: true, description: "Channel kind (e.g. slack, email)" },
    config: { type: "string", required: true, description: "Channel config as JSON string" },
  },
  async run({ args }) {
    const client = makeClient();
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(args.config as string) as Record<string, unknown>;
    } catch {
      process.stderr.write("invalid JSON for --config\n");
      process.exit(1);
    }
    try {
      printJson(
        await client.createNotificationChannel({ name: args.name, kind: args.kind, config }),
      );
    } catch (err) {
      reportCommandError(err);
    }
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
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(args.config as string) as Record<string, unknown>;
    } catch {
      process.stderr.write("invalid JSON for --config\n");
      process.exit(1);
    }
    try {
      printJson(await client.patchNotificationChannel(args.id, body));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const channelsDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a notification channel" },
  args: {
    id: { type: "positional", required: true, description: "Channel id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteNotificationChannel(args.id);
      process.stdout.write("deleted\n");
    } catch (err) {
      reportCommandError(err);
    }
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

// ---- rules ----

const rulesListCmd = defineCommand({
  meta: { name: "list", description: "List notification rules" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listNotificationRules();
      emitList(
        !!args.json,
        ["id", "event_type", "channel_id", "active"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const rulesGetCmd = defineCommand({
  meta: { name: "get", description: "Get a notification rule" },
  args: {
    id: { type: "positional", required: true, description: "Rule id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.listNotificationRules().then(
          ({ items }) =>
            items.find((r) => (r as Record<string, unknown>).id === args.id) ??
            (() => {
              throw new Error(`rule ${args.id} not found`);
            })(),
        ),
      );
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const rulesCreateCmd = defineCommand({
  meta: { name: "create", description: "Create a notification rule" },
  args: {
    event: { type: "string", required: true, description: "Event type" },
    "channel-id": { type: "string", required: true, description: "Channel id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.createNotificationRule({
          event_type: args.event,
          channel_id: args["channel-id"],
        }),
      );
    } catch (err) {
      reportCommandError(err);
    }
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
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(args.body as string) as Record<string, unknown>;
    } catch {
      process.stderr.write("invalid JSON for body\n");
      process.exit(1);
    }
    try {
      printJson(await client.patchNotificationRule(args.id, body));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const rulesDeleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a notification rule" },
  args: {
    id: { type: "positional", required: true, description: "Rule id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteNotificationRule(args.id);
      process.stdout.write("deleted\n");
    } catch (err) {
      reportCommandError(err);
    }
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

// ---- deliveries ----

const deliveriesListCmd = defineCommand({
  meta: { name: "list", description: "List notification deliveries" },
  args: {
    limit: { type: "string", description: "Max rows", default: "50" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listNotificationDeliveries({
        limit: args.limit ? Number(args.limit) : undefined,
      });
      emitList(
        !!args.json,
        ["id", "channel_id", "event_type", "status", "created_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const deliveriesCmd = defineCommand({
  meta: { name: "deliveries", description: "Notification deliveries" },
  subCommands: { list: deliveriesListCmd },
});

// ---- inbox ----

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
    const query: {
      since?: number;
      limit?: number;
      unread_only?: boolean;
      actionable_only?: boolean;
    } = {};
    if (!args.all) query.since = getNotificationInboxCursor();
    if (args.limit) query.limit = Number(args.limit);
    if (args.unread) query.unread_only = true;
    if (args.actionable) query.actionable_only = true;
    const { items, cursor } = await client.getNotificationInbox(query);
    emitList(
      !!args.json,
      ["id", "severity", "actionable", "event_type", "created_at"],
      items as unknown as Record<string, unknown>[],
    );
    // Advance the stored cursor so the next call only surfaces newer
    // rows. `--all` still persists the high-water mark it observed.
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
    try {
      const result = await client.ackNotificationInbox(upToCursor);
      if (args.json) {
        printJson(result);
      } else {
        process.stdout.write(`acked ${result.acked}\n`);
      }
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const inboxCmd = defineCommand({
  meta: { name: "inbox", description: "Read and acknowledge queued notifications" },
  args: inboxListArgs,
  subCommands: {
    list: inboxListCmd,
    ack: inboxAckCmd,
  },
  // Default action when no subcommand is given: list.
  run: ({ args }) => runInboxList(args),
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
