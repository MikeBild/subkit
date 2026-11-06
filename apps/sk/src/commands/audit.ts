import { createWriteStream } from "node:fs";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { auditFilterQuery } from "./audit-filter.ts";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

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
        const q: Record<string, string | number | undefined> = auditFilterQuery(args);
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
          result.items as Record<string, unknown>[],
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
