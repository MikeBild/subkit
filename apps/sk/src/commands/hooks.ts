import { reportCommandError } from "@cli-core/errors";
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
  meta: { name: "list", description: "List inbound webhook bindings" },
  args: {
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listHooksInbound();
      emitList(
        !!args.json,
        ["id", "workflow_id", "event_type", "url"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get an inbound webhook binding" },
  args: {
    id: { type: "positional", required: true, description: "Hook id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.getHookInbound(args.id));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const createCommand = defineCommand({
  meta: { name: "create", description: "Create an inbound webhook binding" },
  args: {
    "workflow-id": { type: "string", required: true, description: "Workflow id to bind" },
    event: { type: "string", description: "Event type filter" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(
        await client.createHookInbound({
          workflow_id: args["workflow-id"],
          event_type: args.event,
        }),
      );
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete an inbound webhook binding" },
  args: {
    id: { type: "positional", required: true, description: "Hook id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteHookInbound(args.id);
      process.stdout.write("deleted\n");
    } catch (err) {
      reportCommandError(err);
    }
  },
});

export const hooksCommand = defineCommand({
  meta: { name: "hooks", description: "Manage inbound webhook bindings" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    create: createCommand,
    delete: deleteCommand,
  },
});
