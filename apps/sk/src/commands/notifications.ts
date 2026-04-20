import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
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
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const deliveriesCmd = defineCommand({
  meta: { name: "deliveries", description: "Notification deliveries" },
  subCommands: { list: deliveriesListCmd },
});

export const notificationsCommand = defineCommand({
  meta: {
    name: "notifications",
    description: "Manage notification channels, rules, and deliveries",
  },
  subCommands: {
    channels: channelsCmd,
    rules: rulesCmd,
    deliveries: deliveriesCmd,
  },
});
