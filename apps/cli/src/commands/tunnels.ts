// `subkit tunnels ...`

import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne } from "../utils/format.ts";

const listCmd = defineCommand({
  meta: { name: "list", description: "List tunnels" },
  args: clientArgs,
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.listTunnels();
    emitList(asJson, ["id", "name", "state", "last_seen_at", "in_flight"], body.items);
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Pre-register a tunnel row" },
  args: {
    ...clientArgs,
    file: { type: "string", description: "Path to tunnel JSON", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = JSON.parse(readFileSync(args.file as string, "utf8")) as Record<string, unknown>;
    const row = await client.createTunnel(body);
    emitOne(asJson, row);
  },
});

export const tunnelsCommand = defineCommand({
  meta: { name: "tunnels", description: "Tunnel registry management" },
  subCommands: { list: listCmd, create: createCmd },
});
