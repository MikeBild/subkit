// `subkit hooks inbound ...`

import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne } from "../utils/format.ts";

const inboundListCmd = defineCommand({
  meta: { name: "list", description: "List inbound webhook bindings" },
  args: clientArgs,
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.listHooksInbound();
    emitList(asJson, ["id", "slug", "workflow_id", "verifier", "active", "created_at"], body.items);
  },
});

const inboundCreateCmd = defineCommand({
  meta: { name: "create", description: "Create an inbound webhook binding from JSON" },
  args: {
    ...clientArgs,
    file: { type: "string", description: "Path to binding JSON", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = JSON.parse(readFileSync(args.file as string, "utf8")) as Record<string, unknown>;
    const row = await client.createHookInbound(body);
    emitOne(asJson, row);
  },
});

const inboundCmd = defineCommand({
  meta: { name: "inbound", description: "Inbound webhook bindings" },
  subCommands: { list: inboundListCmd, create: inboundCreateCmd },
});

export const hooksCommand = defineCommand({
  meta: { name: "hooks", description: "Webhook hook management" },
  subCommands: { inbound: inboundCmd },
});
