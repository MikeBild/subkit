import { createWriteStream } from "node:fs";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import type { AuditLogQuery } from "../engine-client/diagnostics.ts";
import { auditFilterQuery } from "./audit-filter.ts";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

type Enumerated<K extends keyof AuditLogQuery> = readonly NonNullable<AuditLogQuery[K]>[];

const ACTOR_TYPES = [
  "user",
  "system_account",
  "system",
  "unknown",
] as const satisfies Enumerated<"actor_type">;
const ACCESS_TYPES = [
  "api_key",
  "browser_session",
  "mcp_oauth",
  "token_exchange",
  "external_bearer",
  "portal_token",
] as const satisfies Enumerated<"access_type">;
const SOURCES = [
  "api",
  "cli",
  "scheduler",
  "mcp",
  "webhook",
  "tool-chain",
  "ui",
  "chat",
  "queue",
] as const satisfies Enumerated<"request_source">;
const RESULTS = ["success", "denied", "error"] as const satisfies Enumerated<"result">;
const TEXT_FILTERS = [
  "action",
  "actor_id",
  "api_key_id",
  "session_id",
  "oauth_client_id",
  "correlation_id",
  "resource_type",
  "resource_types",
  "resource_id",
  "trace_id",
  "execution_id",
  "conversation_id",
  "workflow_id",
] as const satisfies readonly (keyof AuditLogQuery)[];

function oneOf<T extends string>(flag: string, allowed: readonly T[], value: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (!match) throw new Error(`--${flag} must be one of ${allowed.join(", ")}`);
  return match;
}

export function auditLogQuery(filters: Record<string, string>): AuditLogQuery {
  const query: AuditLogQuery = {};
  for (const key of TEXT_FILTERS) {
    const value = filters[key];
    if (value) query[key] = value;
  }
  if (filters.actor_type) query.actor_type = oneOf("actor-type", ACTOR_TYPES, filters.actor_type);
  if (filters.access_type)
    query.access_type = oneOf("access-type", ACCESS_TYPES, filters.access_type);
  if (filters.request_source)
    query.request_source = oneOf("request-source", SOURCES, filters.request_source);
  if (filters.origin_source)
    query.origin_source = oneOf("origin-source", SOURCES, filters.origin_source);
  if (filters.execution_source)
    query.execution_source = oneOf("execution-source", SOURCES, filters.execution_source);
  if (filters.result) query.result = oneOf("result", RESULTS, filters.result);
  return query;
}

const queryCmd = defineCommand({
  meta: { name: "query", description: "Filter the audit log" },
  args: {
    limit: { type: "string", description: "Max rows" },
    since: {
      type: "string",
      description: "Lower bound — ISO-8601 timestamp or relative (e.g. 10m, 1h, 7d)",
    },
    action: { type: "string", description: "Action name filter" },
    actor: { type: "string", description: "Actor id filter" },
    "actor-type": { type: "string", description: "Actor kind" },
    "api-key-id": { type: "string", description: "Recorded API key id" },
    "session-id": { type: "string", description: "Recorded session id" },
    "access-type": { type: "string", description: "Verified access type" },
    "oauth-client-id": { type: "string", description: "Verified OAuth client id" },
    "request-source": { type: "string", description: "Legacy recorded source (not verified)" },
    "origin-source": { type: "string", description: "Verified initiating source" },
    "execution-source": { type: "string", description: "Immediate server execution step" },
    "correlation-id": { type: "string", description: "Trusted audit correlation id" },
    "resource-type": { type: "string", description: "Resource type" },
    "resource-types": { type: "string", description: "Comma-separated resource types" },
    "resource-id": { type: "string", description: "Filter by resource id" },
    result: { type: "string", description: "success, denied or error" },
    "trace-id": { type: "string", description: "Trace id" },
    "execution-id": { type: "string", description: "Recorded execution id" },
    "conversation-id": { type: "string", description: "Recorded conversation id" },
    "workflow-id": { type: "string", description: "Recorded workflow id" },
    to: { type: "string", description: "Exclusive UTC upper bound (ISO-8601)" },
    cursor: { type: "string", description: "Continue after a previous page (its next_cursor)" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const q = auditLogQuery(auditFilterQuery(args));
        if (args.limit) q.limit = Number(args.limit);
        if (args.since) {
          const raw = String(args.since);
          const relative = raw.match(/^(\d+)(m|h|d)$/);
          if (relative) {
            const [, num, unit] = relative;
            const ms = Number(num) * (unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000);
            q.ts_from = new Date(Date.now() - ms).toISOString();
          } else {
            q.ts_from = raw;
          }
        }
        if (args.to) q.ts_to = String(args.to);
        if (args.cursor) q.cursor = String(args.cursor);
        const result = await client.queryAuditLog(q);
        if (args.json) {
          printJson(result);
          return;
        }
        emitList(
          false,
          [
            "id",
            "ts",
            "action",
            "actor_id",
            "access_type",
            "origin_source",
            "execution_source",
            "result",
          ],
          result.items,
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

const showCmd = defineCommand({
  meta: { name: "show", description: "Fetch one audit event by id" },
  args: { id: { type: "positional", required: true, description: "Audit event id" } },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      printJson(await client.getAuditEvent(String(args.id)));
    });
  },
});

const exportCmd = defineCommand({
  meta: { name: "export", description: "Stream audit log as NDJSON to stdout or a file" },
  args: {
    since: { type: "string", description: "Lower bound — ISO-8601 timestamp" },
    to: { type: "string", description: "Exclusive UTC upper bound (ISO-8601)" },
    action: { type: "string", description: "Action name filter" },
    actor: { type: "string", description: "Actor id filter" },
    "actor-type": { type: "string", description: "Actor kind" },
    "api-key-id": { type: "string", description: "Recorded API key id" },
    "session-id": { type: "string", description: "Recorded session id" },
    "access-type": { type: "string", description: "Verified access type" },
    "oauth-client-id": { type: "string", description: "Verified OAuth client id" },
    "request-source": { type: "string", description: "Legacy recorded source (not verified)" },
    "origin-source": { type: "string", description: "Verified initiating source" },
    "execution-source": { type: "string", description: "Immediate server execution step" },
    "correlation-id": { type: "string", description: "Trusted audit correlation id" },
    "resource-type": { type: "string", description: "Resource type" },
    "resource-types": { type: "string", description: "Comma-separated resource types" },
    "resource-id": { type: "string", description: "Resource id" },
    result: { type: "string", description: "success, denied or error" },
    "trace-id": { type: "string", description: "Trace id" },
    "execution-id": { type: "string", description: "Recorded execution id" },
    "conversation-id": { type: "string", description: "Recorded conversation id" },
    "workflow-id": { type: "string", description: "Recorded workflow id" },
    output: { type: "string", description: "Output file path (default: stdout)" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(async () => {
      const q: Record<string, string | number | undefined> = auditFilterQuery(args);
      if (args.since) q.ts_from = String(args.since);
      if (args.to) q.ts_to = String(args.to);
      const res = await client.exportAuditLog(q);
      if (!res.ok) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = await res.text();
        }
        process.stderr.write(`export failed: ${JSON.stringify(body)}\n`);
        process.exit(2);
      }
      const dest = args.output ? createWriteStream(String(args.output)) : process.stdout;
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          if (dest === process.stdout) {
            process.stdout.write(chunk);
          } else {
            (dest as ReturnType<typeof createWriteStream>).write(chunk);
          }
        }
      }
      const final = decoder.decode();
      if (final) {
        if (dest === process.stdout) {
          process.stdout.write(final);
        } else {
          (dest as ReturnType<typeof createWriteStream>).end(final);
        }
      } else if (dest !== process.stdout) {
        (dest as ReturnType<typeof createWriteStream>).end();
      }
    });
  },
});

export const auditCommand = defineCommand({
  meta: { name: "audit", description: "Query the append-only audit log" },
  subCommands: { query: queryCmd, show: showCmd, export: exportCmd },
});
