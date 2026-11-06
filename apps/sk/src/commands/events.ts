import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import type { AuditLogQuery } from "../engine-client/diagnostics.ts";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

export const AUDIT_EVENT_COLUMNS = ["id", "action", "actor_id", "ts"];

export function auditEventsQuery(args: {
  limit?: string | undefined;
  since?: string | undefined;
  action?: string | undefined;
}): AuditLogQuery {
  const query: AuditLogQuery = {};
  if (args.limit) query.limit = Number(args.limit);
  if (args.since) query.ts_from = args.since;
  if (args.action) query.action = args.action;
  return query;
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
    return withCommandErrors(
      async () => {
        const { items } = await client.queryAuditLog(auditEventsQuery(args));
        emitList(!!args.json, AUDIT_EVENT_COLUMNS, items);
      },
      { json: Boolean(args.json) },
    );
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get an audit event by id" },
  args: {
    id: { type: "positional", required: true, description: "Event id" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.getAuditEvent(args.id));
    });
  },
});

export const eventsCommand = defineCommand({
  meta: { name: "events", description: "Query audit events" },
  subCommands: {
    list: listCommand,
    get: getCommand,
  },
});
