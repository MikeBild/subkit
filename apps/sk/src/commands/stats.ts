// `sk stats <executions|connectors|events|llm>` — scripted-only verb
// over the tenant-scoped runtime stats surface. Zero-config: each
// subcommand has a sensible default bucket + window so it "just works"
// with no flags. Human ASCII table + sparkline by default; `--json`
// emits the raw, stable engine response for cron/CI/ETL.
//
// Client-side validation mirrors the server's window caps so we fail
// fast with a helpful, cap-naming message instead of round-tripping a
// guaranteed 400. A 403 renders as "needs stats:read" guidance.

import { exitCodeFor } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import {
  EngineClient,
  type StatsAuditResponse,
  type StatsExecutionsResponse,
  type StatsLlmResponse,
  type StatsQuery,
} from "../engine-client.ts";
import { humanMs } from "../render/format.ts";

// --- bucket grammar + caps (kept in lock-step with the engine's --------
//     apps/engine/src/http/routes/stats/bucket-window.ts) ----------------
export const BUCKETS = ["minute", "hour", "day", "month", "year"] as const;
export type Bucket = (typeof BUCKETS)[number];

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const WINDOW_CAP_MS: Record<Bucket, number> = {
  minute: 24 * HOUR,
  hour: 31 * DAY,
  day: 366 * DAY,
  month: 60 * 31 * DAY,
  year: 10 * 366 * DAY,
};
const CAP_HINT: Record<Bucket, string> = {
  minute: "minute buckets span at most 24h; narrow --from or use --bucket hour",
  hour: "hour buckets span at most 31d; narrow --from or use --bucket day",
  day: "day buckets span at most 366d; narrow --from or use --bucket month",
  month: "month buckets span at most 60 months; narrow --from or use --bucket year",
  year: "year buckets span at most 10 years; narrow --from",
};

export class ValidationError extends Error {}

/** Resolve a `--from`/`--to` value. Accepts ISO-8601 plus the relative
 *  forms `now`, `now-24h`, `now-7d`, `now-30m`, and `startOfMonth`. */
export function resolveTime(raw: string, nowMs: number): Date {
  const v = raw.trim();
  if (v === "now") return new Date(nowMs);
  if (v === "startOfMonth") {
    const d = new Date(nowMs);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
  const rel = v.match(/^now-(\d+)([mhdw])$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit === "m" ? 60_000 : unit === "h" ? HOUR : unit === "d" ? DAY : 7 * DAY;
    return new Date(nowMs - n * ms);
  }
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(
      `unparseable time '${raw}'; use ISO-8601 or a relative form (now, now-24h, now-7d, startOfMonth)`,
    );
  }
  return parsed;
}

interface Defaults {
  bucket: Bucket;
  from: string;
}

/** Validate + assemble the query. Throws ValidationError on bad input
 *  (caller maps to a non-zero exit). */
export function buildQuery(
  args: Record<string, unknown>,
  defaults: Defaults,
  extra: Record<string, string | undefined>,
): StatsQuery {
  const nowMs = Date.now();
  const bucket = ((args.bucket as string | undefined) ?? defaults.bucket) as Bucket;
  if (!(BUCKETS as readonly string[]).includes(bucket)) {
    throw new ValidationError(
      `invalid --bucket '${bucket}'; expected one of ${BUCKETS.join(", ")}`,
    );
  }
  const fromRaw = (args.from as string | undefined) ?? defaults.from;
  const from = resolveTime(fromRaw, nowMs);
  const to = args.to ? resolveTime(args.to as string, nowMs) : new Date(nowMs);
  if (to.getTime() <= from.getTime()) {
    throw new ValidationError("--to must be after --from");
  }
  if (to.getTime() - from.getTime() > WINDOW_CAP_MS[bucket]) {
    throw new ValidationError(CAP_HINT[bucket]);
  }
  const q: StatsQuery = {
    bucket,
    from: from.toISOString(),
    to: to.toISOString(),
  };
  if (args.tz) q.tz = args.tz as string;
  if (args["group-by"]) q.group_by = args["group-by"] as string;
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== "") q[k] = v;
  }
  return q;
}

// --- rendering helpers -----------------------------------------------------

const SPARK = "▁▂▃▄▅▆▇█";

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 0);
  if (max === 0) return "▁".repeat(values.length);
  return values
    .map((v) => {
      const idx = Math.min(
        SPARK.length - 1,
        Math.max(0, Math.round((v / max) * (SPARK.length - 1))),
      );
      return SPARK[idx];
    })
    .join("");
}

function num(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Right-align a column of cells to a fixed width. */
function padNum(s: string, width: number): string {
  return s.padStart(width);
}

function note(line: string): void {
  process.stdout.write(`${pc.gray(line)}\n`);
}

function emptyWindow(): void {
  process.stdout.write(`${pc.yellow("no data in window")}\n`);
}

function envelopeNote(env: {
  from: string;
  to: string;
  bucket: string;
  truncated_at?: string;
}): void {
  note(`window: ${env.from} → ${env.to} · bucket=${env.bucket}`);
  if (env.truncated_at) {
    process.stdout.write(
      `${pc.yellow(`data aged out before ${env.truncated_at} (audit retention horizon)`)}\n`,
    );
  }
}

function handleError(err: unknown): never {
  if (err instanceof ValidationError) {
    process.stderr.write(`${pc.red("error")}: ${err.message}\n`);
    process.exit(2);
  }
  const e = err as { status?: number; message?: string };
  if (e && e.status === 403) {
    // Reading another user's usage or a cross-user breakdown (group-by=user)
    // needs stats:read:all; the plain operator stats surface needs stats:read.
    const needsReadAll = (e.message ?? "").includes("stats:read:all");
    const perm = needsReadAll ? "stats:read:all" : "stats:read";
    const detail = needsReadAll
      ? "reading another user's usage or a cross-user breakdown"
      : "this command";
    process.stderr.write(
      `${pc.red("forbidden")}: ${detail} needs the ${pc.bold(perm)} permission. ` +
        `Ask an admin to grant it to your role (admins have it by default).\n`,
    );
    process.exit(exitCodeFor(err));
  }
  process.stderr.write(`${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(exitCodeFor(err));
}

// --- subcommands -----------------------------------------------------------

const commonArgs = {
  bucket: { type: "string" as const, description: "minute|hour|day|month|year" },
  from: {
    type: "string" as const,
    description: "ISO-8601 or relative (now-24h, now-7d, startOfMonth)",
  },
  to: { type: "string" as const, description: "ISO-8601 or relative (default: now)" },
  tz: { type: "string" as const, description: "IANA timezone (default UTC)" },
  "group-by": { type: "string" as const, description: "comma-separated group dimensions (≤2)" },
  json: { type: "boolean" as const, description: "raw JSON output", default: false },
};

const executionsCommand = defineCommand({
  meta: {
    name: "executions",
    description:
      "Workflow run volume + duration distribution. Example: sk stats executions --bucket hour --from now-24h",
  },
  args: {
    ...commonArgs,
    "workflow-id": { type: "string", description: "Filter by workflow id" },
    status: {
      type: "string",
      description: "Filter by status (comma-separated: succeeded,failed,…)",
    },
    "request-source": {
      type: "string",
      description: "Filter by request source (open set, e.g. api,scheduler,wait_reaper)",
    },
    "execution-mode": { type: "string", description: "dev|prod" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const q = buildQuery(
        args,
        { bucket: "hour", from: "now-24h" },
        {
          workflow_id: args["workflow-id"] as string | undefined,
          status: args.status as string | undefined,
          request_source: args["request-source"] as string | undefined,
          execution_mode: args["execution-mode"] as string | undefined,
        },
      );
      const res = await client.statsExecutions(q);
      if (args.json) return void printJson(res);
      renderExecutions(res);
    } catch (err) {
      handleError(err);
    }
  },
});

const connectorsCommand = defineCommand({
  meta: {
    name: "connectors",
    description:
      "Connector-call volume + latency + outcome. Example: sk stats connectors --bucket hour --from now-24h",
  },
  args: {
    ...commonArgs,
    "connector-id": { type: "string", description: "Filter by connector id" },
    "connector-slug": { type: "string", description: "Filter by connector slug" },
    driver: { type: "string", description: "Filter by driver (comma-separated)" },
    method: { type: "string", description: "Filter by method (comma-separated)" },
    outcome: { type: "string", description: "Filter by outcome (success,denied,error)" },
    "status-class": {
      type: "string",
      description: "2xx,3xx,4xx_other,4xx_auth,4xx_rate_limited,5xx,network_error,no_status",
    },
    "include-endpoint": { type: "boolean", description: "Add normalized endpoint-path axis" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const q = buildQuery(
        args,
        { bucket: "hour", from: "now-24h" },
        {
          connector_id: args["connector-id"] as string | undefined,
          connector_slug: args["connector-slug"] as string | undefined,
          driver: args.driver as string | undefined,
          method: args.method as string | undefined,
          outcome: args.outcome as string | undefined,
          status_class: args["status-class"] as string | undefined,
        },
      );
      if (args["include-endpoint"]) q.include_endpoint = true;
      const res = await client.statsConnectors(q);
      if (args.json) return void printJson(res);
      renderAudit(res, "connector calls");
    } catch (err) {
      handleError(err);
    }
  },
});

const EVENT_CLASSES = [
  "webhook_outbound",
  "webhook_inbound",
  "chat",
  "notification",
  "schedule",
  "self_healing",
  "discovery",
  "execution_lifecycle",
  "policy",
  "external_write",
];

const eventsCommand = defineCommand({
  meta: {
    name: "events",
    description: `Audit-event volume by class (${EVENT_CLASSES.join(", ")}). Example: sk stats events --class self_healing --bucket day --from now-7d`,
  },
  args: {
    ...commonArgs,
    class: { type: "string", required: true, description: `One of: ${EVENT_CLASSES.join(", ")}` },
    outcome: { type: "string", description: "Filter by outcome (success,denied,error)" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const cls = args.class as string;
      if (!EVENT_CLASSES.includes(cls)) {
        throw new ValidationError(
          `invalid --class '${cls}'; expected one of ${EVENT_CLASSES.join(", ")}`,
        );
      }
      const q = buildQuery(
        args,
        { bucket: "hour", from: "now-24h" },
        {
          class: cls,
          outcome: args.outcome as string | undefined,
        },
      );
      const res = await client.statsEvents(q);
      if (args.json) return void printJson(res);
      renderAudit(res, `events · ${cls}`);
    } catch (err) {
      handleError(err);
    }
  },
});

const llmCommand = defineCommand({
  meta: {
    name: "llm",
    description:
      "LLM token usage + cache-hit + latency. Example: sk stats llm --bucket day --from startOfMonth",
  },
  args: {
    ...commonArgs,
    model: { type: "string", description: "Filter by model (comma-separated)" },
    flow: { type: "string", description: "Filter by flow (comma-separated)" },
    "user-id": {
      type: "string",
      description: "Scope to one user (another user needs stats:read:all)",
    },
    mine: {
      type: "boolean",
      description: "Scope to your own usage (resolves your user id automatically)",
    },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      // `--mine` resolves the caller's own user id from /v1/status so the
      // user never has to know their uuid. Explicit `--user-id` wins.
      let userId = args["user-id"] as string | undefined;
      if (args.mine && !userId) {
        const status = await client.statusSummary();
        userId = status.user.id;
      }
      const q = buildQuery(
        args,
        { bucket: "day", from: "startOfMonth" },
        {
          model: args.model as string | undefined,
          flow: args.flow as string | undefined,
          user_id: userId,
        },
      );
      const res = await client.statsLlm(q);
      if (args.json) return void printJson(res);
      renderLlm(res);
    } catch (err) {
      handleError(err);
    }
  },
});

// --- renderers -------------------------------------------------------------

function renderExecutions(res: StatsExecutionsResponse): void {
  envelopeNote(res);
  const t = res.totals;
  if (t.executions.count === 0) {
    emptyWindow();
    return;
  }
  process.stdout.write(`${pc.bold("Executions")}\n`);
  process.stdout.write(`  total runs:   ${num(t.executions.count)}\n`);
  const byStatus = Object.entries(t.executions.by_status)
    .map(([k, v]) => `${k}=${num(v)}`)
    .join(" · ");
  if (byStatus) process.stdout.write(`  by status:    ${byStatus}\n`);
  const d = t.duration_ms;
  process.stdout.write(
    `  duration:     total=${humanMs(d.total)} avg=${humanMs(d.avg)} p50=${humanMs(d.p50)} p95=${humanMs(d.p95)} p99=${humanMs(d.p99)} max=${humanMs(d.max)}\n`,
  );
  // Sparkline: per-bucket run counts of the first group (or summed if
  // ungrouped, the single synthetic group already carries every bucket).
  const buckets = res.groups[0]?.buckets ?? [];
  if (buckets.length > 0) {
    process.stdout.write(
      `  runs/bucket:  ${pc.cyan(sparkline(buckets.map((b) => b.executions)))}\n`,
    );
  }
  if (res.groups.length > 1 || Object.keys(res.groups[0]?.key ?? {}).length > 0) {
    process.stdout.write(`\n${pc.bold("Groups")}\n`);
    const labelW = Math.max(...res.groups.map((g) => keyLabel(g.key).length), 5);
    for (const g of res.groups) {
      process.stdout.write(
        `  ${keyLabel(g.key).padEnd(labelW)}  runs=${padNum(num(g.totals.executions), 8)}  dur=${humanMs(g.totals.duration_ms.total)}\n`,
      );
    }
  }
}

function renderAudit(res: StatsAuditResponse, title: string): void {
  envelopeNote(res);
  const t = res.totals;
  if (t.calls.total === 0) {
    emptyWindow();
    return;
  }
  process.stdout.write(`${pc.bold(title)}\n`);
  process.stdout.write(`  total calls:  ${num(t.calls.total)}\n`);
  const o = t.calls.by_outcome;
  process.stdout.write(
    `  outcomes:     success=${num(o.success)} · denied=${num(o.denied)} · error=${num(o.error)}\n`,
  );
  const cls = Object.entries(t.calls.by_status_class)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${num(v)}`)
    .join(" · ");
  if (cls) process.stdout.write(`  status class: ${cls}\n`);
  const l = t.latency_ms;
  process.stdout.write(
    `  latency:      total=${humanMs(l.total)} avg=${humanMs(l.avg)} p50=${humanMs(l.p50)} p95=${humanMs(l.p95)} p99=${humanMs(l.p99)} max=${humanMs(l.max)}\n`,
  );
  const buckets = res.groups[0]?.buckets ?? [];
  if (buckets.length > 0) {
    process.stdout.write(`  calls/bucket: ${pc.cyan(sparkline(buckets.map((b) => b.calls)))}\n`);
  }
  if (res.truncated_endpoints) note("  (endpoint axis truncated to top 200 templates)");
  if (res.groups.length > 1 || Object.keys(res.groups[0]?.key ?? {}).length > 0) {
    process.stdout.write(`\n${pc.bold("Groups")}\n`);
    const labelW = Math.max(...res.groups.map((g) => keyLabel(g.key).length), 5);
    for (const g of res.groups) {
      process.stdout.write(
        `  ${keyLabel(g.key).padEnd(labelW)}  calls=${padNum(num(g.totals.calls.total), 8)}  lat=${humanMs(g.totals.latency_ms.total)}\n`,
      );
    }
  }
}

function renderLlm(res: StatsLlmResponse): void {
  envelopeNote(res);
  const t = res.totals;
  if (t.calls.total === 0) {
    emptyWindow();
    return;
  }
  process.stdout.write(`${pc.bold("LLM usage")}\n`);
  process.stdout.write(`  total calls:  ${num(t.calls.total)}\n`);
  const byResult = Object.entries(t.calls.by_result)
    .map(([k, v]) => `${k}=${num(v)}`)
    .join(" · ");
  if (byResult) process.stdout.write(`  by result:    ${byResult}\n`);
  const k = t.tokens;
  const hitRate = k.prompt > 0 ? ((k.cache_read / k.prompt) * 100).toFixed(1) : "0.0";
  process.stdout.write(
    `  tokens:       total=${num(k.total)} (prompt=${num(k.prompt)} completion=${num(k.completion)} cache_read=${num(k.cache_read)} cache_creation=${num(k.cache_creation)})\n`,
  );
  process.stdout.write(`  cache hit:    ${hitRate}% (cache_read / prompt)\n`);
  const l = t.latency_ms;
  process.stdout.write(
    `  latency:      total=${humanMs(l.total)} avg=${humanMs(l.avg)} p50=${humanMs(l.p50)} p95=${humanMs(l.p95)} p99=${humanMs(l.p99)} max=${humanMs(l.max)}\n`,
  );
  const buckets = res.groups[0]?.buckets ?? [];
  if (buckets.length > 0) {
    process.stdout.write(
      `  tokens/bucket:${pc.cyan(sparkline(buckets.map((b) => b.tokens.total)))}\n`,
    );
  }
  if (res.groups.length > 1 || Object.keys(res.groups[0]?.key ?? {}).length > 0) {
    process.stdout.write(`\n${pc.bold("Groups")}\n`);
    const labelW = Math.max(...res.groups.map((g) => keyLabel(g.key).length), 5);
    for (const g of res.groups) {
      process.stdout.write(
        `  ${keyLabel(g.key).padEnd(labelW)}  tokens=${padNum(num(g.totals.tokens.total), 10)}  calls=${num(g.totals.calls)}\n`,
      );
    }
  }
}

function keyLabel(key: Record<string, string>): string {
  const entries = Object.entries(key);
  if (entries.length === 0) return "(all)";
  return entries.map(([k, v]) => `${k}=${v || "∅"}`).join(",");
}

export const statsCommand = defineCommand({
  meta: { name: "stats", description: "Tenant-scoped runtime statistics (needs stats:read)" },
  subCommands: {
    executions: executionsCommand,
    connectors: connectorsCommand,
    events: eventsCommand,
    llm: llmCommand,
  },
});
