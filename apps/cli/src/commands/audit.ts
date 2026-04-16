// `subkit audit ...`
//
// Thin wrapper over the engine's /v1/audit-log read surface. Every
// subcommand prints a table by default and emits JSON with `--json`.
//
// Layout:
//
//   subkit audit query   — one-shot filter + paginated list
//   subkit audit show    — fetch a single row by id
//   subkit audit tail    — cheap poll loop (every 2s) filtered by ts_from
//   subkit audit export  — stream ndjson from /v1/audit-log/export.ndjson
//                          to stdout (SOC2 evidence collection)

import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { EngineError } from "../utils/errors.ts";
import { emitList, printJson, printKeyValue } from "../utils/format.ts";

interface AuditRow {
  id: string;
  ts: string;
  tenant_id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  result: string;
  trace_id: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
}

interface ListResponse {
  items: AuditRow[];
  next_cursor: string | null;
}

// ---------- helpers ----------

const SINCE_REGEX = /^(\d+)\s*(s|m|h|d)?$/i;

function parseSince(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("empty --since value");
  // ISO-8601 string passthrough.
  if (trimmed.includes("T") || trimmed.includes("-")) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`invalid --since: ${value}`);
    }
    return d.toISOString();
  }
  // Duration: 1h, 30m, 7d, 45s.
  const m = SINCE_REGEX.exec(trimmed);
  if (!m) {
    throw new Error(`invalid --since: ${value} (use ISO-8601 or a duration like 1h, 30m, 7d)`);
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  const seconds = unit === "s" ? n : unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n * 86400;
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function serializeRow(row: AuditRow): Record<string, unknown> {
  return {
    ts: row.ts,
    action: row.action,
    actor: row.actor_id ? `${row.actor_type}:${row.actor_id}` : row.actor_type,
    result: row.result,
    resource: row.resource_id ? `${row.resource_type}:${row.resource_id}` : row.resource_type,
    reason: row.reason ?? "",
  };
}

const tableColumns = ["ts", "action", "actor", "result", "resource", "reason"] as const;

// ---------- query ----------

const queryCmd = defineCommand({
  meta: { name: "query", description: "Filter the audit log" },
  args: {
    ...clientArgs,
    action: {
      type: "string",
      description: "Action name (repeatable via comma) — e.g. workflow.created,workflow.deleted",
    },
    since: {
      type: "string",
      description: "Lower ts bound — ISO-8601 or duration (1h, 30m, 7d)",
    },
    until: {
      type: "string",
      description: "Upper ts bound — ISO-8601 or duration (1h, 30m, 7d)",
    },
    actor: { type: "string", description: "Actor id (uuid)" },
    result: { type: "string", description: "success | denied | error" },
    "resource-type": { type: "string", description: "Filter by resource_type" },
    "resource-id": { type: "string", description: "Filter by resource_id" },
    "trace-id": { type: "string", description: "Filter by trace_id" },
    limit: { type: "string", description: "Max rows (default 50, max 500)" },
    before: { type: "string", description: "Cursor (ts) — returns rows strictly older than this" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const q: Record<string, string | number | boolean | undefined> = {};
    if (typeof args.action === "string" && args.action.length > 0) q.action = args.action;
    if (typeof args.since === "string" && args.since.length > 0) {
      q.ts_from = parseSince(args.since);
    }
    if (typeof args.until === "string" && args.until.length > 0) {
      q.ts_to = parseSince(args.until);
    }
    if (typeof args.actor === "string" && args.actor.length > 0) q.actor_id = args.actor;
    if (typeof args.result === "string" && args.result.length > 0) q.result = args.result;
    if (typeof args["resource-type"] === "string" && (args["resource-type"] as string).length > 0) {
      q.resource_type = args["resource-type"] as string;
    }
    if (typeof args["resource-id"] === "string" && (args["resource-id"] as string).length > 0) {
      q.resource_id = args["resource-id"] as string;
    }
    if (typeof args["trace-id"] === "string" && (args["trace-id"] as string).length > 0) {
      q.trace_id = args["trace-id"] as string;
    }
    if (typeof args.limit === "string" && args.limit.length > 0) {
      q.limit = Number(args.limit);
    }
    if (typeof args.before === "string" && args.before.length > 0) q.before = args.before;

    const body = await client.request<ListResponse>("GET", "/v1/audit-log", undefined, q);
    if (asJson) {
      printJson(body);
      return;
    }
    emitList(asJson, tableColumns, body.items.map(serializeRow));
    if (body.next_cursor) {
      process.stdout.write(`\n-- next_cursor: ${body.next_cursor}\n`);
    }
  },
});

// ---------- show ----------

const showCmd = defineCommand({
  meta: { name: "show", description: "Fetch one audit row by id" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Audit row id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const row = await client.request<AuditRow>("GET", `/v1/audit-log/${args.id}`);
    if (asJson) {
      printJson(row);
      return;
    }
    printKeyValue(row as unknown as Record<string, unknown>);
  },
});

// ---------- export ----------

const exportCmd = defineCommand({
  meta: {
    name: "export",
    description: "Stream matching audit rows as NDJSON to stdout (SOC2 evidence)",
  },
  args: {
    ...clientArgs,
    action: { type: "string", description: "Action name (repeatable via comma)" },
    since: { type: "string", description: "Lower ts bound — ISO-8601 or duration" },
    until: { type: "string", description: "Upper ts bound — ISO-8601 or duration" },
    actor: { type: "string", description: "Actor id" },
    result: { type: "string", description: "success | denied | error" },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);
    const q: Record<string, string | number | undefined> = {};
    if (typeof args.action === "string" && args.action.length > 0) q.action = args.action;
    if (typeof args.since === "string" && args.since.length > 0) q.ts_from = parseSince(args.since);
    if (typeof args.until === "string" && args.until.length > 0) q.ts_to = parseSince(args.until);
    if (typeof args.actor === "string" && args.actor.length > 0) q.actor_id = args.actor;
    if (typeof args.result === "string" && args.result.length > 0) q.result = args.result;

    const res = await client.stream("/v1/audit-log/export.ndjson", q);
    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text();
      }
      throw new EngineError(res.status, body as never);
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) process.stdout.write(decoder.decode(value, { stream: true }));
    }
    process.stdout.write(decoder.decode());
  },
});

// ---------- tail ----------

const tailCmd = defineCommand({
  meta: {
    name: "tail",
    description: "Follow new audit rows (poll every 2s, filtered by ts)",
  },
  args: {
    ...clientArgs,
    action: { type: "string", description: "Filter by action name" },
    actor: { type: "string", description: "Filter by actor id" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    let cursor = new Date().toISOString();
    // Simple poll loop — `Ctrl-C` terminates the process, we do not
    // install any signal handling since Node's default is already
    // correct for an interactive tail.
    for (;;) {
      const q: Record<string, string | number | boolean | undefined> = {
        ts_from: cursor,
        limit: 100,
      };
      if (typeof args.action === "string" && args.action.length > 0) q.action = args.action;
      if (typeof args.actor === "string" && args.actor.length > 0) q.actor_id = args.actor;
      const body = await client.request<ListResponse>("GET", "/v1/audit-log", undefined, q);
      // The list endpoint returns rows ordered newest first; replay
      // oldest-to-newest so the tail output reads chronologically.
      const fresh = [...body.items].reverse();
      for (const row of fresh) {
        if (asJson) {
          printJson(row);
        } else {
          const compact = serializeRow(row);
          process.stdout.write(
            `${compact.ts}\t${compact.action}\t${compact.actor}\t${compact.result}\t${compact.resource}\n`,
          );
        }
        // Advance cursor 1ms past the newest row so we don't replay it.
        cursor = new Date(new Date(row.ts).getTime() + 1).toISOString();
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  },
});

// ---------- root ----------

export const auditCommand = defineCommand({
  meta: {
    name: "audit",
    description: "Query the append-only audit log (requires audit:read)",
  },
  subCommands: {
    query: queryCmd,
    show: showCmd,
    export: exportCmd,
    tail: tailCmd,
  },
});

export const __test = { parseSince, serializeRow };
