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
  meta: { name: "list", description: "List system accounts" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listSystemAccounts();
      emitList(!!args.json, ["id", "name", "created_at"], items as Record<string, unknown>[]);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Create a system account" },
  args: { name: { type: "string", required: true, description: "Account name" } },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.createSystemAccount({ name: String(args.name) }));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const deleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a system account" },
  args: { id: { type: "positional", required: true, description: "Account id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      const confirmed = await prompts.confirm({ message: `Delete system account "${args.id}"?` });
      if (!confirmed || prompts.isCancel(confirmed)) return;
      await client.deleteSystemAccount(String(args.id));
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

export const systemAccountsCommand = defineCommand({
  meta: { name: "system-accounts", description: "Manage system accounts" },
  subCommands: { list: listCmd, create: createCmd, delete: deleteCmd },
});
