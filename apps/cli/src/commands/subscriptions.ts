// `subkit subscriptions ...`

import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne } from "../utils/format.ts";

const listCmd = defineCommand({
  meta: { name: "list", description: "List subscriptions" },
  args: clientArgs,
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.listSubscriptions();
    emitList(
      asJson,
      ["id", "event_pattern", "target_url", "active", "consecutive_failures"],
      body.items,
    );
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Create a subscription from JSON" },
  args: {
    ...clientArgs,
    file: { type: "string", description: "Path to subscription JSON", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = JSON.parse(readFileSync(args.file as string, "utf8")) as Record<string, unknown>;
    const row = await client.createSubscription(body);
    emitOne(asJson, row);
  },
});

const deliveriesCmd = defineCommand({
  meta: { name: "deliveries", description: "List subscription deliveries (stub)" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Subscription id", required: true },
  },
  async run() {
    process.stdout.write("subscription deliveries endpoint not yet exposed\n");
  },
});

const replayCmd = defineCommand({
  meta: { name: "replay", description: "Replay a delivery" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Subscription id", required: true },
    delivery_id: { type: "positional", description: "Delivery id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const res = await client.replaySubscriptionDelivery(
      args.id as string,
      args.delivery_id as string,
    );
    emitOne(asJson, res as Record<string, unknown>);
  },
});

export const subscriptionsCommand = defineCommand({
  meta: { name: "subscriptions", description: "Outbound webhook subscriptions" },
  subCommands: { list: listCmd, create: createCmd, deliveries: deliveriesCmd, replay: replayCmd },
});
