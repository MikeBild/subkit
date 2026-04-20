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
  meta: { name: "list", description: "List connector templates" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listConnectorTemplates();
      emitList(!!args.json, ["id", "slug", "name", "driver"], items);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const createCommand = defineCommand({
  meta: { name: "create", description: "Create a connector template" },
  args: {
    slug: { type: "string", required: true, description: "Template slug" },
    name: { type: "string", required: true, description: "Template name" },
    driver: { type: "string", required: true, description: "Driver identifier" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.createConnectorTemplate({
          slug: args.slug,
          name: args.name,
          driver: args.driver,
        }),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a connector template" },
  args: {
    id: { type: "positional", required: true, description: "Template id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteConnectorTemplate(args.id);
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

export const connectorTemplatesCommand = defineCommand({
  meta: { name: "connector-templates", description: "Manage connector templates" },
  subCommands: {
    list: listCommand,
    create: createCommand,
    delete: deleteCommand,
  },
});
