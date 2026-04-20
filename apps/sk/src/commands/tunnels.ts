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
  meta: { name: "list", description: "List tunnels" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listTunnels();
      emitList(
        !!args.json,
        ["id", "name", "status", "endpoint"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get a tunnel" },
  args: {
    id: { type: "positional", required: true, description: "Tunnel id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.getTunnel(args.id));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const createCommand = defineCommand({
  meta: { name: "create", description: "Create a tunnel" },
  args: {
    name: { type: "string", required: true, description: "Tunnel name" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.createTunnel({ name: args.name }));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a tunnel" },
  args: {
    id: { type: "positional", required: true, description: "Tunnel id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteTunnel(args.id);
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

export const tunnelsCommand = defineCommand({
  meta: { name: "tunnels", description: "Manage tunnels" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    create: createCommand,
    delete: deleteCommand,
  },
});
