import { exitCodeFor } from "@cli-core/errors";
import { TransportError } from "@cli-core/errors.ts";
import { printJson } from "@cli-core/format";
import { colorizeLogLevel } from "@cli-core/log-levels";
import { readSse } from "@cli-core/sse.ts";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

interface LogEntry {
  ts: number;
  level: string;
  module?: string;
  action?: string;
  msg?: string;
  fields?: Record<string, unknown>;
}

function parseSince(value: string): number {
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum > 1_000_000_000_000) return Math.floor(asNum);
  const m = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!;
    const ms = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return Date.now() - n * ms;
  }
  const d = Date.parse(value);
  if (!Number.isNaN(d)) return d;
  throw new Error(`invalid --since value: '${value}' (use 5m / 2h / 1d / ISO-8601 / unix-ms)`);
}

function renderPretty(e: LogEntry): string {
  const ts = new Date(e.ts).toISOString();
  const lvl = colorizeLogLevel(e.level);
  const moduleAction =
    e.module || e.action ? pc.magenta(`${e.module ?? "?"}.${e.action ?? "?"}`) : "";
  const msg = e.msg ?? "";
  const extras = e.fields && Object.keys(e.fields).length > 0 ? ` ${JSON.stringify(e.fields)}` : "";
  return `${pc.dim(ts)} ${lvl} ${moduleAction}${moduleAction ? ": " : ""}${msg}${extras}`;
}

export const logsCommand = defineCommand({
  meta: {
    name: "logs",
    description:
      "Tail the engine's runtime log ring. --follow streams via SSE; --since accepts 5m / 2h / 1d / ISO-8601.",
  },
  args: {
    "engine-url": { type: "string", description: "Engine base URL" },
    "api-key": { type: "string", description: "API key (audit:read required)" },
    profile: { type: "string", description: "Use a named profile" },
    follow: { type: "boolean", alias: "f", description: "Live SSE tail (Ctrl-C to stop)" },
    since: {
      type: "string",
      description: "Start time — relative (5m, 2h, 1d), ISO-8601, or unix-ms",
    },
    limit: { type: "string", description: "Max entries when not following (default 200)" },
    module: { type: "string", description: "Filter by module name (e.g. migrate, scheduler)" },
    action: { type: "string", description: "Filter by action (e.g. drift_detected)" },
    level: {
      type: "string",
      description: "Minimum level (trace|debug|info|warn|error|fatal)",
    },
    json: {
      type: "boolean",
      description: "Emit raw NDJSON for piping to jq, instead of pretty-printing",
    },
  },
  async run({ args }) {
    const profile = resolveProfile({
      engine_url: args["engine-url"] as string | undefined,
      api_key: args["api-key"] as string | undefined,
      profile: args.profile as string | undefined,
    });
    if (!profile.api_key) {
      process.stderr.write(
        "subkit logs: no api_key configured for this profile. Run `subkit login` or pass --api-key.\n",
      );
      process.exit(2);
    }

    const client = new EngineClient({
      engine_url: profile.engine_url,
      api_key: profile.api_key,
      tenant: profile.active_tenant_id,
    });

    let since_ms: number | undefined;
    if (args.since) {
      try {
        since_ms = parseSince(args.since as string);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(2);
      }
    }
    const limit = args.limit ? Number(args.limit) : undefined;
    const moduleFilter = args.module as string | undefined;
    const actionFilter = args.action as string | undefined;
    const levelFilter = args.level as string | undefined;

    const print = (e: LogEntry): void => {
      if (args.json) {
        printJson(e);
      } else {
        process.stdout.write(`${renderPretty(e)}\n`);
      }
    };

    try {
      const opts: Parameters<EngineClient["logsTailWindow"]>[0] = {};
      if (since_ms !== undefined) opts.since_ms = since_ms;
      if (limit !== undefined) opts.limit = limit;
      if (moduleFilter) opts.module = moduleFilter;
      if (actionFilter) opts.action = actionFilter;
      if (levelFilter) opts.level = levelFilter;
      const window = await client.logsTailWindow(opts);
      const entries = since_ms === undefined ? window.entries.slice().reverse() : window.entries;
      for (const e of entries) print(e);
      if (!args.follow) return;
      since_ms = window.next_since_ms;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }

    const url = client.logsTailStreamUrl({
      since_ms,
      ...(moduleFilter ? { module: moduleFilter } : {}),
      ...(actionFilter ? { action: actionFilter } : {}),
      ...(levelFilter ? { level: levelFilter } : {}),
    });
    const ac = new AbortController();
    process.on("SIGINT", () => ac.abort());
    process.on("SIGTERM", () => ac.abort());
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          authorization: `Bearer ${profile.api_key}`,
          accept: "text/event-stream",
        },
        signal: ac.signal,
      });
    } catch (err) {
      throw new TransportError(
        `logs stream connect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok || !res.body) {
      process.stderr.write(`logs stream returned HTTP ${res.status}\n`);
      process.exit(1);
    }

    try {
      await readSse(res, (frame) => {
        try {
          print(JSON.parse(frame.data) as LogEntry);
        } catch {}
      });
    } catch {}
  },
});
