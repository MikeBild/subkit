import { exitCodeFor } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import {
  type DiagnosticsRuntime,
  EngineClient,
  type OperatorHealthDigest,
  type StatusSummary,
} from "../engine-client.ts";
import { totalFailureCount } from "../lib/operator-digest.ts";
import { formatTokens, humanMs } from "../render/format.ts";

async function tryFetch<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

const RISK_GLYPH = (severity: "warn" | "critical"): string =>
  severity === "critical" ? pc.red("●") : pc.yellow("●");

function uptimeHuman(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

function renderTokenBudget(status: StatusSummary): void {
  const { tokens_today, tokens_month, monthly_budget_tokens } = status;
  process.stdout.write(`\n${pc.bold("Token budget")}\n`);
  const monthLine =
    monthly_budget_tokens != null && monthly_budget_tokens > 0
      ? `${formatTokens(tokens_month)} / ${formatTokens(monthly_budget_tokens)}`
      : formatTokens(tokens_month);
  const pct =
    monthly_budget_tokens != null && monthly_budget_tokens > 0
      ? Math.min(100, Math.round((tokens_month / monthly_budget_tokens) * 100))
      : null;
  const state = status.monthly_budget_state ?? null;
  const colorize =
    state === "critical"
      ? pc.red
      : state === "tightening"
        ? pc.yellow
        : state === "ample"
          ? (s: string) => s
          : pc.dim;
  process.stdout.write(
    `  month ${colorize(monthLine)}${pct != null ? colorize(` (${pct}%)`) : ""}` +
      `${state ? ` ${colorize(state)}` : ""} · today ${formatTokens(tokens_today)}\n`,
  );
}

function renderDigest(digest: OperatorHealthDigest): void {
  const failing = totalFailureCount(digest);
  process.stdout.write(
    `\n${pc.bold("Failing runs")} ${pc.dim(`(last ${digest.window_hours}h)`)}\n`,
  );
  if (digest.failure_groups.length === 0) {
    process.stdout.write(`  ${pc.green("✔")} no failing runs\n`);
  } else {
    process.stdout.write(
      `  ${pc.red(`${failing} failing run(s) across`)} ${digest.failure_groups.length} cause(s):\n`,
    );
    for (const g of digest.failure_groups.slice(0, 6)) {
      const label = g.workflow_name ?? g.workflow_id ?? "(draft)";
      process.stdout.write(
        `    ${pc.red("●")} [${g.origin}] ${label} · ${g.step_key ?? "?"} · ${pc.red(g.error_code ?? "?")} · ${g.count}×\n`,
      );
    }
  }
  if (digest.risk.length > 0) {
    process.stdout.write(`\n${pc.bold("Risk signals")}\n`);
    for (const r of digest.risk.slice(0, 6)) {
      process.stdout.write(
        `  ${RISK_GLYPH(r.severity)} [${r.severity}] ${r.headline} ${pc.dim(`(${r.metric}=${r.value}, threshold ${r.threshold})`)}\n`,
      );
    }
  }
  if (digest.patch_candidates.open > 0) {
    process.stdout.write(`\n${pc.bold("Self-healing")}\n`);
    process.stdout.write(
      `  ${pc.yellow(`${digest.patch_candidates.open} patch candidate(s) awaiting review`)}\n`,
    );
    for (const p of digest.patch_candidates.items.slice(0, 4)) {
      const label = p.workflow_name ?? p.workflow_id ?? "(workflow)";
      process.stdout.write(
        `    ${pc.dim("·")} ${p.id} · ${label} · [${p.classification}] ${p.summary}\n`,
      );
    }
  }
}

function renderRuntime(rt: DiagnosticsRuntime): void {
  process.stdout.write(`\n${pc.bold("Process runtime")}\n`);
  process.stdout.write(
    `  uptime ${uptimeHuman(rt.uptime_s)} · rss ${rt.memory.rss_mb}MB · heap ${rt.memory.heap_used_mb}/${rt.memory.heap_total_mb}MB · external ${rt.memory.external_mb}MB\n`,
  );
  const waitColor = rt.db_pool.waiting > 0 ? pc.yellow : (s: string) => s;
  const lagColor =
    rt.event_loop_lag_ms >= 200
      ? pc.red
      : rt.event_loop_lag_ms >= 50
        ? pc.yellow
        : (s: string) => s;
  process.stdout.write(
    `  db-pool ${rt.db_pool.total} total · ${rt.db_pool.idle} idle · ${waitColor(`${rt.db_pool.waiting} waiting`)}` +
      ` · event-loop lag ${lagColor(humanMs(rt.event_loop_lag_ms))}\n`,
  );
}

export const healthCommand = defineCommand({
  meta: {
    name: "health",
    description:
      "Runtime posture: liveness, token budget, failing runs, risk signals, schema drift, and process runtime. Use `sk doctor` for connectivity/setup.",
  },
  args: {
    "engine-url": { type: "string", description: "Engine base URL" },
    "window-hours": {
      type: "string",
      description: "Lookback window for failing runs (default 24)",
    },
    json: { type: "boolean", description: "JSON output (composite object)" },
  },
  async run({ args }) {
    const profile = resolveProfile({ engine_url: args["engine-url"] as string | undefined });
    const client = new EngineClient({
      engine_url: profile.engine_url,
      api_key: profile.api_key,
      tenant: profile.active_tenant_id,
    });

    let liveness: Awaited<ReturnType<EngineClient["health"]>>;
    let readiness: Awaited<ReturnType<EngineClient["ready"]>> | null = null;
    try {
      liveness = await client.health();
      readiness = await tryFetch(() => client.ready());
    } catch (err) {
      process.stderr.write(`unreachable: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }

    const windowHours = args["window-hours"] ? Number(args["window-hours"]) : undefined;
    const [status, digest, drift, runtime] = await Promise.all([
      tryFetch(() => client.statusSummary()),
      tryFetch(() =>
        client.getOperatorHealthDigest(windowHours != null ? { window_hours: windowHours } : {}),
      ),
      tryFetch(() => client.driftReport()),
      tryFetch(() => client.diagnosticsRuntime()),
    ]);

    if (args.json) {
      printJson({ health: liveness, ready: readiness, budget: status, digest, drift, runtime });
      return;
    }

    process.stdout.write(
      `\n${pc.bold("sk health")} · engine ${pc.dim(profile.engine_url)} · tenant ${pc.cyan(profile.active_tenant_id ?? "(none)")}\n`,
    );
    const liveGlyph = readiness?.status === "ready" ? pc.green("✔") : pc.yellow("⚠");
    process.stdout.write(
      `${liveGlyph} live=${liveness.status} · ready=${readiness?.status ?? "unreachable"} · version ${liveness.version}\n`,
    );

    if (status) renderTokenBudget(status);

    if (
      digest &&
      (!digest.all_clear || digest.failure_groups.length > 0 || (digest.risk?.length ?? 0) > 0)
    ) {
      renderDigest({ ...digest, risk: digest.risk ?? [] });
    } else {
      process.stdout.write(`\n${pc.bold("Failing runs")}\n  ${pc.green("✔")} nothing flagged\n`);
    }

    if (drift) {
      const unknown = drift.unknown_in_db.length;
      const historical = drift.historical_in_db.length;
      const missing = drift.missing_in_db.length;
      process.stdout.write(`\n${pc.bold("Schema")}\n`);
      if (unknown === 0 && missing === 0) {
        process.stdout.write(
          `  ${pc.green("✔")} embedded=${drift.embedded_migration_count} db=${drift.db_migration_count} ` +
            `(current${historical > 0 ? `; accepted_history=${historical}` : ""})\n`,
        );
      } else {
        process.stdout.write(
          `  ${pc.yellow("⚠")} drift: unknown_in_db=${unknown} accepted_history=${historical} ` +
            `missing_in_db=${missing} — run \`sk doctor\` for resolution\n`,
        );
      }
    }

    if (runtime) renderRuntime(runtime);

    process.stdout.write("\n");
  },
});
