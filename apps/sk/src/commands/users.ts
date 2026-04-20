import * as prompts from "@clack/prompts";
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

const listCmd = defineCommand({
  meta: { name: "list", description: "List identity users" },
  args: {
    limit: { type: "string", description: "Max rows" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const q: Record<string, string | number | undefined> = {};
      if (args.limit) q.limit = Number(args.limit);
      const { items } = await client.listIdentityUsers(q);
      emitList(
        !!args.json,
        ["id", "email", "display_name", "kind", "created_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Fetch a user by id" },
  args: { id: { type: "positional", required: true, description: "User id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.getIdentityUser(String(args.id)));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const patchCmd = defineCommand({
  meta: { name: "patch", description: "Update a user's display name" },
  args: {
    id: { type: "positional", required: true, description: "User id" },
    "display-name": { type: "string", required: true, description: "New display name" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.patchIdentityUser(String(args.id), {
          display_name: String(args["display-name"]),
        }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const deleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a user" },
  args: { id: { type: "positional", required: true, description: "User id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const confirmed = await prompts.confirm({ message: `Delete user "${args.id}"?` });
      if (!confirmed || prompts.isCancel(confirmed)) return;
      await client.deleteIdentityUser(String(args.id));
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

export const usersCommand = defineCommand({
  meta: { name: "users", description: "Manage identity users" },
  subCommands: { list: listCmd, get: getCmd, patch: patchCmd, delete: deleteCmd },
});
