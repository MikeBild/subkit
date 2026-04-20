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

const listCommand = defineCommand({
  meta: { name: "list", description: "List subscriptions" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listSubscriptions();
      emitList(
        !!args.json,
        ["id", "event_type", "workflow_id", "active"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get a subscription" },
  args: {
    id: { type: "positional", required: true, description: "Subscription id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.getSubscription(args.id));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const createCommand = defineCommand({
  meta: { name: "create", description: "Create a subscription" },
  args: {
    event: { type: "string", required: true, description: "Event type" },
    "workflow-id": { type: "string", required: true, description: "Workflow id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.createSubscription({
          event_type: args.event,
          workflow_id: args["workflow-id"],
        }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const patchCommand = defineCommand({
  meta: { name: "patch", description: "Update a subscription" },
  args: {
    id: { type: "positional", required: true, description: "Subscription id" },
    active: { type: "string", required: true, description: "Set active state (true|false)" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.patchSubscription(args.id, { active: args.active === "true" }));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a subscription" },
  args: {
    id: { type: "positional", required: true, description: "Subscription id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteSubscription(args.id);
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const deliveriesCommand = defineCommand({
  meta: { name: "deliveries", description: "Show deliveries for a subscription" },
  args: {
    id: { type: "positional", required: true, description: "Subscription id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const sub = await client.getSubscription(args.id);
      printJson((sub as Record<string, unknown>).deliveries ?? []);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const replayCommand = defineCommand({
  meta: { name: "replay", description: "Replay a subscription delivery" },
  args: {
    "sub-id": { type: "positional", required: true, description: "Subscription id" },
    "delivery-id": { type: "positional", required: true, description: "Delivery id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.replaySubscriptionDelivery(args["sub-id"], args["delivery-id"]);
      process.stdout.write("replayed\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

export const subscriptionsCommand = defineCommand({
  meta: { name: "subscriptions", description: "Manage event subscriptions" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    create: createCommand,
    patch: patchCommand,
    delete: deleteCommand,
    deliveries: deliveriesCommand,
    replay: replayCommand,
  },
});
