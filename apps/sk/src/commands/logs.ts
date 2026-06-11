// `sk logs` — tail the engine's structured runtime log ring.
//
// Usage:
//   sk logs --follow                          # live SSE tail
//   sk logs --since 5m                        # last 5 minutes, then exit
//   sk logs --since 5m --follow               # catch up + live tail
//   sk logs --module migrate --action drift_detected
//   sk logs --level warn                      # only warn/error/fatal
//   sk logs --json                            # raw NDJSON; pipe to jq
//
// Backed by GET /v1/diagnostics/logs (paginated) and
// /v1/diagnostics/logs/stream (SSE). Both require `audit:read`.
//
// This is the operator-facing counterpart to the engine's in-process
// drift detection: when `sk doctor` flags a problem, `sk logs --follow
// --module migrate` shows the migration log lines that produced it
// without SSH-ing into the container.

import { exitCodeFor } from "@cli-core/errors";
import { isEngineError, TransportError } from "@cli-core/errors.ts";
import { printJson } from "@cli-core/format";
import { colorizeLogLevel } from "@cli-core/log-levels";
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
  // Absolute unix-ms passes through unchanged.
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum > 1_000_000_000_000) return Math.floor(asNum);
  // Relative duration (1s, 5m, 2h, 1d).
  const m = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!;
    const ms = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return Date.now() - n * ms;
  }
  // ISO-8601.
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
        "sk logs: no api_key configured for this profile. Run `sk login` or pass --api-key.\n",
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

    // 1. Initial window (catch-up). Always pull, even when --follow, so
    //    the operator sees recent context immediately rather than only
    //    new events going forward.
    try {
      const opts: Parameters<EngineClient["logsTailWindow"]>[0] = {};
      if (since_ms !== undefined) opts.since_ms = since_ms;
      if (limit !== undefined) opts.limit = limit;
      if (moduleFilter) opts.module = moduleFilter;
      if (actionFilter) opts.action = actionFilter;
      if (levelFilter) opts.level = levelFilter;
      const window = await client.logsTailWindow(opts);
      // tail() returns newest-first when no since_ms is set; reverse so
      // the operator reads chronologically.
      const entries = since_ms === undefined ? window.entries.slice().reverse() : window.entries;
      for (const e of entries) print(e);
      if (!args.follow) return;
      // Live tail picks up where the window left off.
      since_ms = window.next_since_ms;
    } catch (err) {
      if (isEngineError(err) && err.status === 404) {
        process.stderr.write(
          "engine does not expose /v1/diagnostics/logs — upgrade the engine to a build that includes the #149 observability work.\n",
        );
        process.exit(1);
      }
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }

    // 2. SSE live tail.
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

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    while (!done) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          done = true;
          break;
        }
        if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
      } catch {
        break;
      }
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const block of events) {
        if (!block.trim()) continue;
        if (block.startsWith(":")) continue; // heartbeat
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const entry = JSON.parse(dataLine.slice("data: ".length)) as LogEntry;
          print(entry);
        } catch {
          // Malformed payload — drop it rather than abort the stream.
        }
      }
    }
  },
});
