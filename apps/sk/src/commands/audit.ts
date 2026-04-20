import { createWriteStream } from "node:fs";
import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { readSse } from "@cli-core/index.ts";
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

// ---------- query ----------

const queryCmd = defineCommand({
  meta: { name: "query", description: "Filter the audit log" },
  args: {
    limit: { type: "string", description: "Max rows" },
    since: { type: "string", description: "Lower bound — ISO-8601 timestamp" },
    action: { type: "string", description: "Action name filter" },
    actor: { type: "string", description: "Actor id filter" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const q: Record<string, string | number | undefined> = {};
      if (args.limit) q.limit = Number(args.limit);
      if (args.since) q.ts_from = String(args.since);
      if (args.action) q.action = String(args.action);
      if (args.actor) q.actor_id = String(args.actor);
      const { items } = await client.queryAuditLog(q);
      emitList(
        !!args.json,
        ["id", "action", "actor_id", "created_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

// ---------- show ----------

const showCmd = defineCommand({
  meta: { name: "show", description: "Fetch one audit event by id" },
  args: { id: { type: "positional", required: true, description: "Audit event id" } },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.getAuditEvent(String(args.id)));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

// ---------- export ----------

const exportCmd = defineCommand({
  meta: { name: "export", description: "Stream audit log as NDJSON to stdout or a file" },
  args: {
    since: { type: "string", description: "Lower bound — ISO-8601 timestamp" },
    output: { type: "string", description: "Output file path (default: stdout)" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const q: Record<string, string | number | undefined> = {};
      if (args.since) q.ts_from = String(args.since);
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
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

// ---------- tail ----------

const tailCmd = defineCommand({
  meta: { name: "tail", description: "Follow new audit events via SSE stream" },
  args: {},
  async run() {
    const client = makeClient();
    try {
      const res = await client.stream("/v1/audit-log/stream");
      await readSse(res, (frame) => {
        process.stdout.write(`${frame.data}\n`);
      });
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

// ---------- root ----------

export const auditCommand = defineCommand({
  meta: { name: "audit", description: "Query the append-only audit log" },
  subCommands: { query: queryCmd, show: showCmd, export: exportCmd, tail: tailCmd },
});
