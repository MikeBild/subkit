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
  meta: { name: "list", description: "List audit events" },
  args: {
    limit: { type: "string", description: "Max rows", default: "50" },
    since: { type: "string", description: "ISO timestamp lower bound" },
    action: { type: "string", description: "Filter by action" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listEvents({
        limit: args.limit ? Number(args.limit) : undefined,
        since: args.since as string | undefined,
        action: args.action as string | undefined,
      });
      emitList(
        !!args.json,
        ["id", "action", "actor", "created_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get an audit event by id" },
  args: {
    id: { type: "positional", required: true, description: "Event id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.getAuditEvent(args.id));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

export const eventsCommand = defineCommand({
  meta: { name: "events", description: "Query audit events" },
  subCommands: {
    list: listCommand,
    get: getCommand,
  },
});
