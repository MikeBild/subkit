import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

export const SUBSCRIPTION_LIST_COLUMNS = [
  "id",
  "event_pattern",
  "target_url",
  "active",
  "consecutive_failures",
  "circuit_open_until",
];

export function parseActiveFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--active must be "true" or "false", got "${value}"`);
}

export function buildCreateSubscriptionBody(args: {
  "event-pattern": string;
  "target-url": string;
  secret: string;
  active?: string | undefined;
}): { event_pattern: string; target_url: string; secret: string; active?: boolean } {
  const active = parseActiveFlag(args.active);
  return {
    event_pattern: args["event-pattern"],
    target_url: args["target-url"],
    secret: args.secret,
    ...(active === undefined ? {} : { active }),
  };
}

export function buildPatchSubscriptionBody(args: {
  "event-pattern"?: string | undefined;
  "target-url"?: string | undefined;
  secret?: string | undefined;
  active?: string | undefined;
}): { event_pattern?: string; target_url?: string; secret?: string; active?: boolean } {
  const active = parseActiveFlag(args.active);
  const body: { event_pattern?: string; target_url?: string; secret?: string; active?: boolean } =
    {};
  if (args["event-pattern"] !== undefined) body.event_pattern = args["event-pattern"];
  if (args["target-url"] !== undefined) body.target_url = args["target-url"];
  if (args.secret !== undefined) body.secret = args.secret;
  if (active !== undefined) body.active = active;
  if (Object.keys(body).length === 0) {
    throw new Error("nothing to update: pass --event-pattern, --target-url, --secret or --active");
  }
  return body;
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List subscriptions" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listSubscriptions();
        emitList(!!args.json, SUBSCRIPTION_LIST_COLUMNS, items);
      },
      { json: Boolean(args.json) },
    );
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get a subscription" },
  args: {
    id: { type: "positional", required: true, description: "Subscription id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.getSubscription(args.id));
    });
  },
});

const createCommand = defineCommand({
  meta: { name: "create", description: "Create a subscription" },
  args: {
    "event-pattern": {
      type: "string",
      required: true,
      description: "Event pattern to match, e.g. execution.* or execution.failed",
    },
    "target-url": {
      type: "string",
      required: true,
      description: "HTTPS URL that receives the signed delivery",
    },
    secret: { type: "string", required: true, description: "Signing secret for deliveries" },
    active: { type: "string", description: "Initial active state (true|false)" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.createSubscription(buildCreateSubscriptionBody(args)));
    });
  },
});

const patchCommand = defineCommand({
  meta: { name: "patch", description: "Update a subscription" },
  args: {
    id: { type: "positional", required: true, description: "Subscription id" },
    "event-pattern": { type: "string", description: "New event pattern" },
    "target-url": { type: "string", description: "New target URL" },
    secret: { type: "string", description: "New signing secret" },
    active: { type: "string", description: "Set active state (true|false)" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.patchSubscription(args.id, buildPatchSubscriptionBody(args)));
    });
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a subscription" },
  args: {
    id: { type: "positional", required: true, description: "Subscription id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      await client.deleteSubscription(args.id);
      process.stdout.write("deleted\n");
    });
  },
});

const deliveriesCommand = defineCommand({
  meta: { name: "deliveries", description: "Show deliveries for a subscription" },
  args: {
    id: { type: "positional", required: true, description: "Subscription id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      const sub = await client.getSubscription(args.id);
      printJson((sub as Record<string, unknown>).deliveries ?? []);
    });
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
    return withCommandErrors(async () => {
      await client.replaySubscriptionDelivery(args["sub-id"], args["delivery-id"]);
      process.stdout.write("replayed\n");
    });
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
