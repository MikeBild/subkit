import * as prompts from "@clack/prompts";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

const listCmd = defineCommand({
  meta: { name: "list", description: "List system accounts" },
  args: { json: { type: "boolean", description: "JSON output" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const { items } = await client.listSystemAccounts();
        emitList(!!args.json, ["id", "name", "created_at"], items);
      },
      { json: Boolean(args.json) },
    );
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Create a system account" },
  args: { name: { type: "string", required: true, description: "Account name" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.createSystemAccount({ name: String(args.name) }));
    });
  },
});

const deleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a system account" },
  args: { id: { type: "positional", required: true, description: "Account id" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      const confirmed = await prompts.confirm({ message: `Delete system account "${args.id}"?` });
      if (!confirmed || prompts.isCancel(confirmed)) return;
      await client.deleteSystemAccount(String(args.id));
      process.stdout.write("deleted\n");
    });
  },
});

export const systemAccountsCommand = defineCommand({
  meta: { name: "system-accounts", description: "Manage system accounts" },
  subCommands: { list: listCmd, create: createCmd, delete: deleteCmd },
});
